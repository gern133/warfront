import { WebSocket } from 'ws';
import { TICK_MS, SPAWN_WAIT_S, MAX_HUMANS, Difficulty, MapType, ServerMsg } from '../../shared/protocol';
import { rleEncode } from '../../shared/rle';
import { Game } from '../game';

// --- Комнаты и состояние соединений ---
export type RoomPhase = 'lobby' | 'spawn' | 'running';

export interface Room {
  code: string;
  game: Game;
  clients: Set<WebSocket>;
  host: WebSocket | null; // null у публичной комнаты
  phase: RoomPhase;
  spawnTicks: number; // тиков осталось на выбор спавна
  difficulty: Difficulty;
  map: MapType;
  isPublic: boolean;
  speed: number; // скорость игры: 0 пауза, 1, 2, 3, 10
  resetTimer: ReturnType<typeof setTimeout> | null;
  winnerSent: number | null; // id уже объявленного победителя (чтобы не слать повторно)
}

export interface CState {
  playerId: number | null;
  name: string;
  room: Room | null;
  needResync: boolean; // клиент отставал (буфер забит) — при восстановлении ресинк
  proposals: Set<number>; // id игроков, приславших этому клиенту предложение союза
}

export const rooms = new Map<string, Room>();
export const clients = new Map<WebSocket, CState>();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих I/L/O/0/1
export function genCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(code)) return code;
  }
}

export function makeRoom(code: string, difficulty: Difficulty, map: MapType, isPublic: boolean): Room {
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
    speed: 1,
    resetTimer: null,
    winnerSent: null,
  };
  rooms.set(code, room);
  return room;
}

export const publicRoom = makeRoom('QUICK', 'easy', 'earth', true);
publicRoom.phase = 'running';
publicRoom.game.addBots('easy');

export function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function sendInit(ws: WebSocket, st: CState, room: Room) {
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

export function broadcastLobby(room: Room) {
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

export function leaveRoom(ws: WebSocket, st: CState) {
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
export function enterGame(ws: WebSocket, st: CState, room: Room) {
  const p = room.game.addPlayer(st.name);
  st.playerId = p.id;
  sendInit(ws, st, room);
}

// Запуск раунда: боты на карту, всем — фаза выбора спавна с таймером
export function beginRound(room: Room) {
  room.phase = 'spawn';
  room.spawnTicks = (SPAWN_WAIT_S * 1000) / TICK_MS;
  room.game.addBots(room.difficulty);
  for (const cws of room.clients) {
    const cst = clients.get(cws);
    if (cst) enterGame(cws, cst, room);
  }
}

export function resetRoom(room: Room) {
  room.winnerSent = null;
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

export function roomFull(room: Room): boolean {
  return room.clients.size >= MAX_HUMANS;
}

export function cleanName(raw: unknown): string {
  return String(raw || '').trim().slice(0, 16) || 'Аноним';
}

// Фаза спавна: все люди выбрали точку или вышло время — запускаем игру
export function checkSpawnPhase(room: Room) {
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
