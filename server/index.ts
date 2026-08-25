import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { TICK_MS, PORT, ClientMsg, ServerMsg } from '../shared/protocol';
import { rleEncode } from '../shared/rle';
import { earthTerrain } from './map/earthmap';
import { setEarthTerrainProvider } from './game/index';
import { buildView } from './game/view';
import type { IntentResult } from '../shared/types/intent';
import { clients, rooms, send, checkSpawnPhase, fixUnspawned, leaveRoom, CState } from './net/rooms';
import { handleMessage } from './net/handlers';

// прогреваем кэш карты Земли на старте, чтобы первое лобби не ждало генерацию
{
  const t0 = Date.now();
  setEarthTerrainProvider(earthTerrain);
  earthTerrain();
  console.log(`Карта Земли сгенерирована за ${Date.now() - t0} мс`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

// --- HTTP: раздача собранного клиента из dist/ (в dev клиент крутится на vite) ---
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(DIST, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Warfront server работает. Клиент: npm run dev (vite на :5173) или npm run build.');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// --- WebSocket: подключения и маршрутизация сообщений ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const st: CState = { playerId: null, name: '', room: null, needResync: false, spawnPicked: false, snapshotAt: 0, proposals: new Set(), localSim: false };
  clients.set(ws, st);

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    handleMessage(ws, st, msg);
  });

  ws.on('close', () => {
    leaveRoom(ws, st);
    clients.delete(ws);
  });
});

// --- Игровой цикл: тикаем все запущенные комнаты ---
let intervalNo = 0;
setInterval(() => {
  intervalNo++;
  const FULL_RESYNC_TICKS = 100; // полная посылка зданий раз в 10 с (страховка)
  const sendPlayers = intervalNo % 5 === 0; // полный список игроков — раз в 500мс
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    // публичная комната без людей заморожена — боты не съедают карту впустую
    if (room.isPublic && room.clients.size === 0) continue;
    const game = room.game;
    const intentErrors: IntentResult[] = [];

    if (room.phase === 'running') {
      // накопитель поддерживает дробную скорость: 0.5 — тик раз в 2 интервала,
      // 1/2/3/10 — целое число тиков за интервал
      room.tickAccum += room.speed;
      while (room.tickAccum >= 1) {
        // Команды применяются внутри tick на границе хода; ошибки возвращаются
        // отправителям (раньше ответ уходил сразу из обработчика).
        for (const r of game.tick()) intentErrors.push(r);
        room.tickAccum -= 1;
      }
    } else checkSpawnPhase(room);
    if (room.spawnFixAt) fixUnspawned(room);

    // ответы на команды (ошибки) — тем, кто их отправил
    if (intentErrors.length) {
      for (const r of intentErrors) {
        for (const ws of room.clients) {
          const cst = clients.get(ws);
          if (cst?.playerId !== r.id) continue;
          if (r.error) send(ws, { type: 'error', message: r.error });
          break;
        }
      }
      intentErrors.length = 0;
    }
    // предложения союза человеку: игра сложила их в исходящий ящик
    if (game.proposalsOut.length) {
      for (const pr of game.proposalsOut) {
        for (const ws of room.clients) {
          const cst = clients.get(ws);
          if (cst?.playerId !== pr.to) continue;
          cst.proposals.add(pr.from);
          send(ws, { type: 'proposal', from: pr.from, name: game.playerName(pr.from) });
          break;
        }
      }
      game.proposalsOut.length = 0;
    }

    for (const ws of room.clients) {
      const cst = clients.get(ws);
      if (cst && cst.playerId !== null && game.deaths.includes(cst.playerId)) {
        send(ws, { type: 'dead' });
        cst.playerId = null;
      }
    }
    game.deaths.length = 0;

    // Данные для отрисовки собирает общая функция — её же использует воркер на
    // клиенте в режиме локальной симуляции (см. server/game/view.ts).
    const view = buildView(game, {
      sendPlayers,
      fullBuildings: intervalNo % FULL_RESYNC_TICKS === 0,
      withHash: intervalNo % 10 === 0,
      speed: room.speed,
      humans: room.clients.size,
    });
    const update = JSON.stringify(view satisfies ServerMsg);
    // Клиентам с локальной симуляцией состояние мира не нужно: им достаточно потока
    // ходов. Это и есть выигрыш модели lockstep — 0.27 КБ/с против 118 КБ/с.
    const turnsOnly = JSON.stringify({
      type: 'update',
      turn: view.turn,
      turnNo: view.turnNo,
      hash: view.hash,
      speed: view.speed,
      humans: view.humans,
    } satisfies ServerMsg);
    for (const ws of room.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const cst = clients.get(ws);
      // буфер забит — пропускаем кадр (иначе очередь растёт → 30-сек лаг)
      if (ws.bufferedAmount >= 256 * 1024) {
        if (cst) cst.needResync = true;
        continue;
      }
      // клиент отставал и восстановился — шлём полный снимок владельцев, а не
      // дельту (пропущенные дельты уже потеряны)
      if (cst?.needResync) {
        cst.needResync = false;
        send(ws, { type: 'resync', ownersRle: rleEncode(game.owners) });
        continue;
      }
      // клиент, считающий симуляцию сам, получает только поток ходов
      ws.send(cst?.localSim ? turnsOnly : update);
    }

    // отношения изменились — шлём затронутым игрокам их персональные списки
    if (game.relChanged.size) {
      for (const ws of room.clients) {
        const cst = clients.get(ws);
        if (!cst || cst.playerId === null || !game.relChanged.has(cst.playerId)) continue;
        const rel = game.relationsFor(cst.playerId);
        send(ws, { type: 'relations', allies: rel.allies, enemies: rel.enemies });
      }
      game.relChanged.clear();
    }

    // события союзов (расторжения) — шлём в ленту тому, с кем расторгли
    if (game.relNotices.length) {
      for (const n of game.relNotices) {
        for (const ws of room.clients) {
          const cst = clients.get(ws);
          if (cst?.playerId !== n.to) continue;
          send(ws, { type: 'notice', kind: n.kind, name: n.name, x: n.x, y: n.y });
          break;
        }
      }
      game.relNotices.length = 0;
    }

    // объявляем победителя один раз; карту НЕ сбрасываем — ждём выбора игрока
    // (Реванш или Продолжить играть) в модалке на клиенте
    if (game.winnerId !== null && room.winnerSent !== game.winnerId) {
      room.winnerSent = game.winnerId;
      const w = game.players.get(game.winnerId);
      for (const ws of room.clients)
        send(ws, { type: 'winner', name: w?.name ?? '?', id: game.winnerId });
    }
  }
}, TICK_MS);

const LISTEN_PORT = Number(process.env.PORT) || PORT;
server.listen(LISTEN_PORT, () => {
  console.log(`Warfront server: http://localhost:${LISTEN_PORT} (ws на том же порту)`);
});
