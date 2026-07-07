import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  TICK_MS,
  PORT,
  SPAWN_WAIT_S,
  MAX_HUMANS,
  ClientMsg,
  ServerMsg,
  Difficulty,
  MapType,
} from '../shared/protocol';
import { Game } from './game';
import { earthTerrain } from './earthmap';
import { rleEncode } from '../shared/rle';

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

// --- Комнаты ---
type RoomPhase = 'lobby' | 'spawn' | 'running';

interface Room {
  code: string;
  game: Game;
  clients: Set<WebSocket>;
  host: WebSocket | null; // null у публичной комнаты
  phase: RoomPhase;
  spawnTicks: number; // тиков осталось на выбор спавна
  difficulty: Difficulty;
  map: MapType;
  isPublic: boolean;
  resetTimer: ReturnType<typeof setTimeout> | null;
}

interface CState {
  playerId: number | null;
  name: string;
  room: Room | null;
}

const rooms = new Map<string, Room>();
const clients = new Map<WebSocket, CState>();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих I/L/O/0/1
function genCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(code)) return code;
  }
}

function makeRoom(code: string, difficulty: Difficulty, map: MapType, isPublic: boolean): Room {
  const room: Room = {
    code,
    game: new Game(map),
    clients: new Set(),
    host: null,
    phase: 'lobby',
    spawnTicks: 0,
    difficulty,
    map,
    isPublic,
    resetTimer: null,
  };
  rooms.set(code, room);
  return room;
}

const publicRoom = makeRoom('QUICK', 'normal', 'random', true);
publicRoom.phase = 'running';
publicRoom.game.addBots('normal');

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendInit(ws: WebSocket, st: CState, room: Room) {
  send(ws, {
    type: 'init',
    selfId: st.playerId ?? -1,
    code: room.code,
    w: room.game.w,
    h: room.game.h,
    terrainRle: rleEncode(room.game.terrain),
    ownersRle: rleEncode(room.game.owners),
    players: room.game.playersPub(),
    ...(room.phase === 'spawn'
      ? { spawnSeconds: Math.ceil((room.spawnTicks * TICK_MS) / 1000) }
      : {}),
  });
}

function broadcastLobby(room: Room) {
  const roster = [...room.clients].map((w) => clients.get(w)?.name ?? '?');
  for (const ws of room.clients) {
    send(ws, {
      type: 'lobby',
      code: room.code,
      host: ws === room.host,
      difficulty: room.difficulty,
      map: room.map,
      players: roster,
    });
  }
}

function leaveRoom(ws: WebSocket, st: CState) {
  const room = st.room;
  if (!room) return;
  room.clients.delete(ws);
  if (st.playerId !== null) room.game.removePlayer(st.playerId);
  st.playerId = null;
  st.room = null;
  if (!room.isPublic) {
    if (room.clients.size === 0) {
      if (room.resetTimer) clearTimeout(room.resetTimer);
      rooms.delete(room.code);
    } else if (room.host === ws) {
      room.host = room.clients.values().next().value ?? null;
      if (room.phase === 'lobby') broadcastLobby(room);
    }
  } else if (room.clients.size === 0) {
    // последний человек ушёл из быстрой игры — свежий мир для следующего
    if (room.resetTimer) {
      clearTimeout(room.resetTimer);
      room.resetTimer = null;
    }
    room.game.reset();
    room.game.addBots(room.difficulty);
  }
}

// Игрок входит в идущую игру: создаём "не заспавненного" игрока,
// клиент переходит в фазу выбора точки старта
function enterGame(ws: WebSocket, st: CState, room: Room) {
  const p = room.game.addPlayer(st.name);
  st.playerId = p.id;
  sendInit(ws, st, room);
}

// Запуск раунда: боты на карту, всем — фаза выбора спавна с таймером
function beginRound(room: Room) {
  room.phase = 'spawn';
  room.spawnTicks = (SPAWN_WAIT_S * 1000) / TICK_MS;
  room.game.addBots(room.difficulty);
  for (const cws of room.clients) {
    const cst = clients.get(cws);
    if (cst) enterGame(cws, cst, room);
  }
}

function resetRoom(room: Room) {
  room.game.reset();
  if (room.isPublic) {
    room.game.addBots(room.difficulty);
    for (const cws of room.clients) {
      const cst = clients.get(cws);
      if (cst) enterGame(cws, cst, room);
    }
  } else {
    beginRound(room);
  }
}

function roomFull(room: Room): boolean {
  return room.clients.size >= MAX_HUMANS;
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const st: CState = { playerId: null, name: '', room: null };
  clients.set(ws, st);

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case 'quick': {
        if (roomFull(publicRoom)) {
          send(ws, { type: 'error', message: 'Комната заполнена (макс. 100 игроков)' });
          return;
        }
        leaveRoom(ws, st);
        st.name = cleanName(msg.name);
        st.room = publicRoom;
        publicRoom.clients.add(ws);
        enterGame(ws, st, publicRoom);
        break;
      }
      case 'create': {
        leaveRoom(ws, st);
        st.name = cleanName(msg.name);
        const diff: Difficulty = ['easy', 'normal', 'hard', 'insane'].includes(msg.difficulty)
          ? msg.difficulty
          : 'normal';
        const map: MapType = msg.map === 'earth' ? 'earth' : 'random';
        const room = makeRoom(genCode(), diff, map, false);
        room.host = ws;
        room.clients.add(ws);
        st.room = room;
        broadcastLobby(room);
        break;
      }
      case 'joinLobby': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room || room.isPublic) {
          send(ws, { type: 'error', message: 'Лобби с таким кодом не найдено' });
          return;
        }
        if (roomFull(room)) {
          send(ws, { type: 'error', message: 'Комната заполнена (макс. 100 игроков)' });
          return;
        }
        leaveRoom(ws, st);
        st.name = cleanName(msg.name);
        st.room = room;
        room.clients.add(ws);
        if (room.phase === 'lobby') broadcastLobby(room);
        else enterGame(ws, st, room);
        break;
      }
      case 'start': {
        const room = st.room;
        if (!room || room.isPublic || room.phase !== 'lobby' || room.host !== ws) return;
        beginRound(room);
        break;
      }
      case 'spawn': {
        const room = st.room;
        if (!room || room.phase === 'lobby' || st.playerId === null) return;
        if (room.game.trySpawn(st.playerId, msg.cell | 0)) {
          send(ws, { type: 'spawned' });
        }
        break;
      }
      case 'respawn': {
        const room = st.room;
        if (!room || room.phase !== 'running' || st.playerId !== null) return;
        // если игрок в комнате один — реванш создаёт новый мир (свежая карта +
        // боты); если игроков несколько, общий мир не трогаем
        if (room.clients.size <= 1) {
          if (room.resetTimer) {
            clearTimeout(room.resetTimer);
            room.resetTimer = null;
          }
          room.game.reset();
          room.game.addBots(room.difficulty);
        }
        // затем игрок выбирает точку высадки вручную
        enterGame(ws, st, room);
        break;
      }
      case 'attack': {
        const room = st.room;
        if (!room || room.phase !== 'running' || st.playerId === null) return;
        room.game.launchAttackCell(st.playerId, msg.cell | 0, +msg.ratio);
        break;
      }
      case 'invade': {
        const room = st.room;
        if (!room || room.phase !== 'running' || st.playerId === null) return;
        const ok = room.game.launchInvasion(st.playerId, msg.cell | 0, +msg.ratio);
        if (!ok) send(ws, { type: 'error', message: 'Нет морского пути к этой цели' });
        break;
      }
      case 'recall': {
        const room = st.room;
        if (!room || room.phase !== 'running' || st.playerId === null) return;
        room.game.recallBoat(st.playerId, msg.boatId | 0);
        break;
      }
      case 'build': {
        const room = st.room;
        if (!room || room.phase !== 'running' || st.playerId === null) return;
        const err = room.game.build(st.playerId, msg.bt, msg.cell | 0);
        if (err) send(ws, { type: 'error', message: err });
        break;
      }
      case 'upgrade': {
        const room = st.room;
        if (!room || room.phase !== 'running' || st.playerId === null) return;
        const err = room.game.upgrade(st.playerId, msg.cell | 0);
        if (err) send(ws, { type: 'error', message: err });
        break;
      }
      case 'leave': {
        leaveRoom(ws, st);
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(ws, st);
    clients.delete(ws);
  });
});

function cleanName(raw: unknown): string {
  return String(raw || '').trim().slice(0, 16) || 'Аноним';
}

// Фаза спавна: все люди выбрали точку или вышло время — запускаем игру
function checkSpawnPhase(room: Room) {
  room.spawnTicks--;
  let allSpawned = true;
  let anyHuman = false;
  for (const cws of room.clients) {
    const cst = clients.get(cws);
    if (cst?.playerId == null) continue;
    anyHuman = true;
    const p = room.game.players.get(cst.playerId);
    if (p && !p.spawned) allSpawned = false;
  }
  if ((anyHuman && allSpawned) || room.spawnTicks <= 0) {
    for (const cws of room.clients) {
      const cst = clients.get(cws);
      if (cst?.playerId == null) continue;
      const p = room.game.players.get(cst.playerId);
      if (p && !p.spawned) {
        room.game.spawnRandom(p); // не успел выбрать — случайная точка
        send(cws, { type: 'spawned' });
      }
    }
    room.phase = 'running';
    for (const cws of room.clients) send(cws, { type: 'roundStart' });
  }
}

// --- Игровой цикл: тикаем все запущенные комнаты ---
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') continue;
    // публичная комната без людей заморожена — боты не съедают карту впустую
    if (room.isPublic && room.clients.size === 0) continue;
    const game = room.game;

    if (room.phase === 'running') game.tick();
    else checkSpawnPhase(room);

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
      players: game.playersPub(),
      attacks: game.attacksPub(),
      boats: game.boatsPub(),
      buildings: game.buildingsPub(),
    } satisfies ServerMsg);
    for (const ws of room.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(update);
    }

    if (game.winnerId !== null && !room.resetTimer) {
      const w = game.players.get(game.winnerId);
      for (const ws of room.clients) send(ws, { type: 'winner', name: w?.name ?? '?' });
      room.resetTimer = setTimeout(() => {
        resetRoom(room);
        room.resetTimer = null;
      }, 8000);
    }
  }
}, TICK_MS);

const LISTEN_PORT = Number(process.env.PORT) || PORT;
server.listen(LISTEN_PORT, () => {
  console.log(`Warfront server: http://localhost:${LISTEN_PORT} (ws на том же порту)`);
});
