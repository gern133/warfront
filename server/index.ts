import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { TICK_MS, PORT, ClientMsg, ServerMsg } from '../shared/protocol';
import { rleEncode } from '../shared/rle';
import { earthTerrain } from './map/earthmap';
import { clients, rooms, send, checkSpawnPhase, leaveRoom, CState } from './net/rooms';
import { handleMessage } from './net/handlers';

// прогреваем кэш карты Земли на старте, чтобы первое лобби не ждало генерацию
{
  const t0 = Date.now();
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
  const st: CState = { playerId: null, name: '', room: null, needResync: false, proposals: new Set() };
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
  const sendPlayers = intervalNo % 5 === 0; // полный список игроков — раз в 500мс
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    // публичная комната без людей заморожена — боты не съедают карту впустую
    if (room.isPublic && room.clients.size === 0) continue;
    const game = room.game;

    if (room.phase === 'running') {
      for (let i = 0; i < room.speed; i++) game.tick(); // ускорение: тик N раз
    } else checkSpawnPhase(room);

    for (const ws of room.clients) {
      const cst = clients.get(ws);
      if (cst && cst.playerId !== null && game.deaths.includes(cst.playerId)) {
        send(ws, { type: 'dead' });
        cst.playerId = null;
      }
    }
    game.deaths.length = 0;

    const changes: number[] = [];
    for (const [c, o] of game.changed) changes.push(c, o);
    game.changed.clear();

    const update = JSON.stringify({
      type: 'update',
      changes,
      // список игроков (300 объектов, ~30КБ) шлём реже — клиент всё равно
      // показывает армии/золото раз в 1–5с; дельты клеток идут каждый тик
      players: sendPlayers ? game.playersPub() : [],
      attacks: game.attacksPub(),
      boats: game.boatsPub(),
      buildings: game.buildingsPub(),
      ships: game.tradeShipsPub(),
      warships: game.warshipsPub(),
      shots: game.bulletsPub(),
      missiles: game.missilesPub(),
      earnings: game.tradeEarnings,
      speed: room.speed,
      humans: room.clients.size,
    } satisfies ServerMsg);
    game.tradeEarnings = []; // события уже сериализованы в update — сбрасываем
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
      ws.send(update);
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
