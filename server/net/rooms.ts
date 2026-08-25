import { WebSocket } from 'ws';
import { gzip } from 'node:zlib';
import { TICK_MS, SPAWN_WAIT_S, MAX_HUMANS, Difficulty, MapType, ServerMsg } from '../../shared/protocol';
import { rleEncode } from '../../shared/rle';
import { Game, setEarthTerrainProvider } from '../game';
import { earthTerrain } from '../map/earthmap';

// Провайдер карты Земли подставляем ЗДЕСЬ, а не только в server/index.ts: этот модуль
// создаёт публичную комнату (а значит и Game) прямо при загрузке, и по правилам ESM
// это происходит РАНЬШЕ, чем выполнится тело server/index.ts. Симуляция сама карту
// Земли читать не может — её код идёт и в браузерный воркер, куда node:fs не тянем.
setEarthTerrainProvider(earthTerrain);

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
  speed: number; // скорость игры: 0 пауза, 0.5, 1, 2, 3, 10
  tickAccum: number; // накопитель для дробной скорости (0.5 — тик через раз)
  infMoney: boolean; // настройка лобби: бесконечные деньги (100млн) у людей
  infArmy: boolean; // настройка лобби: бесконечная армия (потолок 100млн) у людей
  resetTimer: ReturnType<typeof setTimeout> | null;
  winnerSent: number | null; // id уже объявленного победителя (чтобы не слать повторно)
  // Ход, на котором проверяем, что все люди действительно высадились. Две высадки
  // могли претендовать на один плацдарм: проверка при клике прошла у обоих, а
  // применилась только первая. Кто остался без территории — получает случайную точку.
  spawnFixAt: number;
  // ОБЩИЙ снимок состояния для клиентов с локальной симуляцией. Собирается один раз
  // и уходит всем, кто входит следом: сборка со сжатием стоит около 150 мс процессора,
  // и при массовом входе (100 человек за три секунды) сто персональных снимков съедали
  // больше ядра целиком. Разрыв между временем снимка и моментом запроса закрывается
  // хвостом ходов.
  snap: { tick: number; buf: Buffer; at: number } | null;
  snapWaiting: Set<WebSocket>;
  snapBuilding: boolean;
}

export interface CState {
  // Клиент сам считает симуляцию (модель lockstep): состояние мира ему не нужно,
  // достаточно потока ходов. Включается сообщением 'localSim'.
  localSim: boolean;
  playerId: number | null;
  name: string;
  room: Room | null;
  needResync: boolean; // клиент отставал (буфер забит) — при восстановлении ресинк
  // Игрок уже выбрал точку высадки. Держим на соединении, а не смотрим на
  // `player.spawned`: команда `spawn` применяется на тике, а в фазе высадки мир не
  // тикает — иначе фаза не заканчивается досрочно, даже когда все выбрали.
  spawnPicked: boolean;
  // Когда этому клиенту последний раз отдавали снимок симуляции: он весит порядка
  // мегабайта, поэтому чаще раза в две секунды не собираем.
  snapshotAt: number;
  proposals: Set<number>; // id игроков, приславших этому клиенту предложение союза
}

/** Отдать клиенту снимок симуляции — для позднего подключения и после расхождения.
 *  Снимок большой (несколько МБ текста), поэтому едет отдельным СЖАТЫМ бинарным
 *  кадром: обычные сообщения не сжимаются, включать сжатие на весь сокет ради
 *  одного разового снимка дорого по процессору. */
/** Сколько снимок годится к переиспользованию. Всё это время он раздаётся как есть, а
 *  накопившиеся с тех пор ходы едут отдельным хвостом — он маленький (5 с это 50 ходов). */
const SNAP_TTL_MS = 5000;

export function sendSimSnapshot(ws: WebSocket, st: CState) {
  const room = st.room;
  if (!room) return; // вне комнаты снимать нечего (в фазе выбора спавна ход ещё 0)
  const now = Date.now();
  if (now - st.snapshotAt < 2000) return; // защита от спама запросами
  st.snapshotAt = now;
  // свежий снимок уже есть — отдаём как есть, ничего не считая
  if (room.snap && now - room.snap.at < SNAP_TTL_MS) {
    serveSnapshot(ws, room, room.snap);
    return;
  }
  room.snapWaiting.add(ws);
  buildSnapshot(room);
}

/** Собрать снимок ОДИН раз на всех ожидающих. */
function buildSnapshot(room: Room) {
  if (room.snapBuilding) return; // уже собираем — ожидающие получат этот же снимок
  room.snapBuilding = true;
  const tick = room.game.tickNo;
  const payload = JSON.stringify({
    type: 'simSnapshot',
    turnNo: tick,
    snap: room.game.snapshot(),
  } satisfies ServerMsg);
  // gzip асинхронно (в пуле потоков): 4 МБ синхронно — это ~100 мс паузы в тиках
  gzip(payload, (err, buf) => {
    room.snapBuilding = false;
    const waiting = [...room.snapWaiting];
    room.snapWaiting.clear();
    if (err || !buf) return;
    room.snap = { tick, buf, at: Date.now() };
    for (const w of waiting) serveSnapshot(w, room, room.snap);
  });
}

function serveSnapshot(ws: WebSocket, room: Room, snap: { tick: number; buf: Buffer }) {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Ходы от снимка до текущего момента — ПЕРЕД снимком: клиент положит их в очередь и
  // разберёт после восстановления. Без них общий (чуть устаревший) снимок дал бы
  // разрыв в последовательности ходов, и клиент запросил бы всё заново.
  const turns: unknown[][] = [];
  for (let t = snap.tick; t < room.game.tickNo; t++) turns.push(room.game.turnLog[t] ?? []);
  if (turns.length) send(ws, { type: 'simTurns', from: snap.tick, turns });
  // compress: false — снимок уже сжат gzip'ом, второй проход только жжёт процессор
  ws.send(snap.buf, { binary: true, compress: false });
}

/** Снимок предыдущего раунда непригоден: нумерация ходов начинается заново. */
export function dropSnapshot(room: Room) {
  room.snap = null;
  room.snapWaiting.clear();
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
    tickAccum: 0,
    infMoney: false,
    infArmy: false,
    resetTimer: null,
    winnerSent: null,
    spawnFixAt: 0,
    snap: null,
    snapWaiting: new Set(),
    snapBuilding: false,
  };
  rooms.set(code, room);
  return room;
}

export const publicRoom = makeRoom('QUICK', 'easy', 'earth', true);
publicRoom.phase = 'running';
publicRoom.game.addBots('easy');

/** Страховка после старта раунда: кто из людей так и не высадился (клетку занял
 *  другой игрок на том же тике) — получает случайную точку, а не пустой старт. */
export function fixUnspawned(room: Room) {
  if (!room.spawnFixAt || room.game.tickNo < room.spawnFixAt) return;
  room.spawnFixAt = 0;
  for (const cws of room.clients) {
    const cst = clients.get(cws);
    if (cst?.playerId == null) continue;
    const p = room.game.players.get(cst.playerId);
    if (p && p.alive && !p.spawned) {
      room.game.enqueue({ t: 'spawnRandom', id: p.id });
      send(cws, { type: 'spawned' });
    }
  }
}

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
    mapType: room.map, // клиентской симуляции нужен тот же тип карты
    seed: room.game.seed, // по нему партия воспроизводится побитово (см. shared/rng.ts)
    difficulty: room.difficulty, // клиентской симуляции нужны те же боты
    tickNo: room.game.tickNo,
    players: room.game.playersPub(),
    // статику отдаём целиком: новому клиенту нужны имена всех игроков. Именно
    // playersMetaAll, а не playersMetaPub — тот обновил бы общую подпись, и
    // остальные клиенты не узнали бы имя вошедшего.
    playersMeta: room.game.playersMetaAll(),
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
      settings: { infMoney: room.infMoney, infArmy: room.infArmy },
    });
  }
}

export function leaveRoom(ws: WebSocket, st: CState) {
  const room = st.room;
  if (!room) return;
  room.clients.delete(ws);
  room.snapWaiting.delete(ws);
  // Выход — тоже команда: см. enterGame про локальные симуляции остальных.
  if (st.playerId !== null) room.game.enqueue({ t: 'leave', id: st.playerId });
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
  // Вход в партию — команда с ЗАРАНЕЕ выданным id: так партия воспроизводится из
  // журнала команд (id входит в команду, а не выдаётся внутри симуляции).
  // Вход — КОМАНДА, а не прямая правка мира. Иначе локальные симуляции остальных
  // игроков о новичке не узнают: у них в партии его просто нет, и через пару тиков
  // хеши расходятся. id бронируем заранее — он нужен сразу для `init`.
  const id = room.game.reserveId();
  room.game.enqueue({ t: 'join', id, name: st.name });
  st.playerId = id;
  st.spawnPicked = false;
  sendInit(ws, st, room);
}

// Запуск раунда: боты на карту, всем — фаза выбора спавна с таймером
export function beginRound(room: Room) {
  dropSnapshot(room);
  room.phase = 'spawn';
  room.spawnTicks = (SPAWN_WAIT_S * 1000) / TICK_MS;
  // Бесконечные деньги/армия работают и в онлайне: настройка комнаты применяется ко
  // ВСЕМ людям сразу (в игре она проверяется как `!p.bot`), поэтому преимущества ни у
  // кого нет. Раньше сбрасывалась, если в комнате больше одного игрока.
  room.game.infMoney = room.infMoney; // применяем настройки лобби к игре
  room.game.infArmy = room.infArmy;
  room.game.addBots(room.difficulty);
  for (const cws of room.clients) {
    const cst = clients.get(cws);
    if (cst) enterGame(cws, cst, room);
  }
}

export function resetRoom(room: Room) {
  dropSnapshot(room);
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
    if (!cst.spawnPicked) allSpawned = false;
  }
  if ((anyHuman && allSpawned) || room.spawnTicks <= 0) {
    for (const cws of room.clients) {
      const cst = clients.get(cws);
      if (cst?.playerId == null) continue;
      if (!cst.spawnPicked) {
        // не успел выбрать — случайная точка, но КОМАНДОЙ: иначе воспроизведение
        // партии из журнала разошлось бы (это внешнее воздействие по таймеру)
        room.game.enqueue({ t: 'spawnRandom', id: cst.playerId });
        cst.spawnPicked = true;
        send(cws, { type: 'spawned' });
      }
    }
    room.phase = 'running';
    // команды высадки применятся на первом тике — на следующем проверим результат
    room.spawnFixAt = room.game.tickNo + 2;
    for (const cws of room.clients) send(cws, { type: 'roundStart' });
  }
}
