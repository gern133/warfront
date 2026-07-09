import {
  PlayerPub,
  AttackPub,
  BoatPub,
  BuildingPub,
  BuildingType,
  Difficulty,
  MapType,
  START_MONEY,
  hqCost,
  HQ_RADIUS,
  HQ_BUILD_TICKS,
  HQ_FUSE_TICKS,
  HQ_EXPLODE_RADIUS,
  MAX_HQ_LEVEL,
  hqUpgradeCost,
  hqUpgradeTicks,
  TradeShipPub,
  TradeEarn,
  PORT_BUILD_COST,
  PORT_BUILD_TICKS,
  PORT_SHIP_INTERVAL,
  PORT_RADIUS,
  portUpgradeCost,
  tradeValue,
  shipsForLevel,
} from '../shared/protocol';
import { earthTerrain, fbm, smoothstep, EARTH_W, EARTH_H } from './earthmap';

export interface Player {
  id: number;
  name: string;
  troops: number;
  maxTroops: number;
  cells: number;
  alive: boolean;
  spawned: boolean; // человек ещё не выбрал точку старта — false
  bot: boolean;
  strong: boolean;
  passive: boolean; // слабые боты-«корм»: только расширяются в нейтраль
  growthMul: number;
  maxMul: number; // множитель потолка войск (у корма втрое меньше)
  money: number;
  thinkAt: number;
  spawnTick: number; // когда игрок высадился (для раннего буста роста)
}

interface Building {
  id: number;
  owner: number;
  cell: number;
  type: BuildingType;
  readyTick: number; // тик, на котором постройка завершится
  level: number; // 1 обычный, 2 взрыв по области, 3 усиленный
  fuseTick: number; // тик взрыва после захвата (0 = не тикает)
  upStart: number; // тик начала апгрейда (0 = не улучшается)
  upEnd: number; // тик завершения апгрейда
  nextShipTick: number; // порт: когда выпускать следующий корабль
  ships: number; // порт: кораблей в полёте
}

interface TradeShip {
  id: number;
  owner: number;
  portCell: number; // домашний порт (для учёта кораблей)
  path: number[]; // маршрут по воде
  cum: number[];
  totalLen: number;
  traveled: number;
  returning: boolean; // возвращается домой
  payout: number; // деньги за заход (с учётом уровня и дистанции)
  done: boolean; // рейс завершён — на удаление
  x: number;
  y: number;
}

const TRADE_SPEED = 0.6; // клеток за тик

interface Attack {
  player: number;
  target: number; // id владельца-цели, 0 = нейтральная земля
  troops: number;
  frontier: Set<number>; // волна захвата, поддерживается инкрементально
  rescanned: boolean; // полный пересбор фронта уже был после опустошения
}

interface Boat {
  id: number;
  player: number;
  target: number; // владелец берега-цели на момент отправки
  troops: number;
  path: number[]; // маршрут по воде: [x0,y0,x1,y1,...] в клетках
  cum: number[]; // накопленная дистанция в каждой точке пути (cum[0]=0)
  totalLen: number; // полная длина маршрута
  traveled: number; // пройдено вдоль маршрута (0..totalLen)
  returning: boolean; // отозван — возвращается к старту
  landCell: number; // клетка берега для высадки
  x: number; // текущая позиция на маршруте
  y: number;
}

const BOAT_SPEED = 0.6; // клеток за тик

const RANDOM_W = 560;
const RANDOM_H = 560;
const LAND_RATIO = 0.5;
const SPAWN_TROOPS = 600;
const NEUTRAL_COST = 1.4;
// Рост замедляется, когда войск больше 70% от максимума (за 30% до потолка)
const GROWTH_SLOW_FROM = 0.7;
// Доля фронта, захватываемая за тик — задаёт «постепенность» движения границы
const WAVE_SPEED = 0.15;

// Слабые племена — пассивный «корм»: их всегда 275, они растут вдвое медленнее
// игрока, имеют втрое меньший потолок и лишь расширяются в нейтраль. Страны
// (25 штук) — полноценные противники; сложность задаёт их силу относительно
// игрока и агрессивность.
export const WEAK_COUNT = 275;
export const STRONG_COUNT = 25;
const WEAK_GROWTH = 0.5; // вдвое медленнее игрока
const WEAK_MAX = 1 / 3; // потолок войск втрое меньше

export const DIFFICULTY: Record<
  Difficulty,
  { strongMul: number; aggro: number }
> = {
  easy: { strongMul: 0.8, aggro: 0.7 }, // страны слабее игрока
  normal: { strongMul: 1.0, aggro: 1.0 }, // как игрок
  hard: { strongMul: 1.2, aggro: 1.25 }, // на 20% сильнее
  insane: { strongMul: 1.5, aggro: 1.6 }, // на 50% сильнее
};

// Слабые боты: случайные имена из сочетаний (нужно >= WEAK_COUNT комбинаций)
const NAME_ADJ = [
  'Дикие', 'Лесные', 'Степные', 'Горные', 'Северные', 'Южные', 'Багровые',
  'Чёрные', 'Золотые', 'Серые', 'Огненные', 'Ледяные', 'Тёмные', 'Вольные',
  'Древние', 'Кровавые', 'Туманные', 'Речные', 'Пустынные', 'Небесные',
];
const NAME_NOUN = [
  'Волки', 'Вороны', 'Медведи', 'Змеи', 'Ястребы', 'Кабаны', 'Лисы', 'Быки',
  'Драконы', 'Шакалы', 'Тигры', 'Барсы', 'Грифы', 'Псы', 'Рыси', 'Соколы',
  'Скорпионы', 'Пантеры',
];

const STRONG_NAMES = [
  '🇺🇸 США', '🇨🇳 Китай', '🇷🇺 Россия', '🇩🇪 Германия', '🇬🇧 Британия',
  '🇫🇷 Франция', '🇯🇵 Япония', '🇹🇷 Турция', '🇮🇳 Индия', '🇧🇷 Бразилия',
  '🇨🇦 Канада', '🇦🇺 Австралия', '🇪🇸 Испания', '🇮🇹 Италия', '🇲🇽 Мексика',
  '🇰🇷 Корея', '🇮🇩 Индонезия', '🇸🇦 Аравия', '🇦🇷 Аргентина', '🇵🇱 Польша',
  '🇳🇱 Нидерланды', '🇸🇪 Швеция', '🇨🇭 Швейцария', '🇳🇴 Норвегия', '🇺🇦 Украина',
  '🇪🇬 Египет', '🇿🇦 ЮАР', '🇳🇬 Нигерия', '🇵🇰 Пакистан', '🇻🇳 Вьетнам',
  '🇹🇭 Таиланд', '🇬🇷 Греция', '🇵🇹 Португалия', '🇨🇿 Чехия', '🇭🇺 Венгрия',
  '🇫🇮 Финляндия', '🇩🇰 Дания', '🇮🇪 Ирландия', '🇮🇱 Израиль', '🇰🇿 Казахстан',
];

function pickShuffled(names: string[], n: number): string[] {
  const pool = [...names];
  const out: string[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  }
  return out;
}

function weakNames(n: number): string[] {
  const combos: string[] = [];
  for (const a of NAME_ADJ) for (const b of NAME_NOUN) combos.push(`${a} ${b}`);
  return pickShuffled(combos, n);
}

// Сглаживание ломаной (углы срезаются по Чайкину), концы сохраняются
function chaikin(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const out: number[] = [pts[0], pts[1]];
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const bx = pts[(i + 1) * 2];
    const by = pts[(i + 1) * 2 + 1];
    out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25);
    out.push(ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

export class Game {
  readonly mapType: MapType;
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  terrain: Uint8Array; // 1 = суша, 0 = вода
  owners: Int16Array; // 0 = нейтрально, иначе id игрока
  players = new Map<number, Player>();
  // клетки каждого игрока (с ленивыми «протухшими» записями) — чтобы боты и
  // построение фронта не сканировали всю карту, а только свою территорию
  cellsOf = new Map<number, number[]>();
  attacks: Attack[] = [];
  boats: Boat[] = [];
  buildings: Building[] = [];
  private nextBuildingId = 1;
  tradeShips: TradeShip[] = [];
  private nextShipId = 1;
  tradeEarnings: TradeEarn[] = []; // заработок портов за интервал (чистится в index)
  // связи (симметричные): союзники и враги. Храним только пары с участием
  // человека — бот-vs-бот всегда нейтральны. relChanged — кому переслать обновление.
  allies = new Map<number, Set<number>>();
  hostiles = new Map<number, Set<number>>();
  relChanged = new Set<number>();
  // кэш морских маршрутов между клетками портов (порты статичны)
  private routeCache = new Map<number, { path: number[]; cum: number[]; totalLen: number } | null>();
  // поле укреплений: id владельца штаба, покрывающего клетку (0 = нет).
  // пересобирается только при изменении зданий — в бою это O(1) чтение
  fortField: Int16Array;
  private fortLevel: Uint8Array; // уровень укрепляющего штаба на клетку (0 нет)
  private fortDirty = true;
  landId: Int16Array; // id связного материка для каждой клетки суши (-1 = вода)
  difficulty: Difficulty = 'normal';
  // грубая водная сетка для поиска морских путей (обход островов)
  private cw = 0;
  private ch = 0;
  private ck = 1; // коэффициент огрубления
  private cwater: Uint8Array = new Uint8Array(0); // 1 = проходимая вода
  changed = new Map<number, number>(); // cell -> новый владелец, копится за тик
  deaths: number[] = [];
  tickNo = 0;
  landCount = 0;
  winnerId: number | null = null;
  private nextId = 1;
  private nextBoatId = 1;

  constructor(mapType: MapType = 'random') {
    this.mapType = mapType;
    this.w = mapType === 'earth' ? EARTH_W : RANDOM_W;
    this.h = mapType === 'earth' ? EARTH_H : RANDOM_H;
    this.cells = this.w * this.h;
    this.terrain = new Uint8Array(this.cells);
    this.owners = new Int16Array(this.cells);
    this.landId = new Int16Array(this.cells);
    this.fortField = new Int16Array(this.cells);
    this.fortLevel = new Uint8Array(this.cells);
    this.genTerrain();
    this.computeLandIds();
    this.buildWaterGrid();
  }

  reset() {
    this.terrain.fill(0);
    this.owners.fill(0);
    this.players.clear();
    this.cellsOf.clear();
    this.attacks = [];
    this.boats = [];
    this.buildings = [];
    this.tradeShips = [];
    this.tradeEarnings = [];
    this.allies.clear();
    this.hostiles.clear();
    this.relChanged.clear();
    this.routeCache.clear();
    this.fortField.fill(0);
    this.fortLevel.fill(0);
    this.fortDirty = true;
    this.changed.clear();
    this.deaths = [];
    this.winnerId = null;
    this.genTerrain();
    this.computeLandIds();
    this.buildWaterGrid();
  }

  // Грубая сетка воды: блок K×K проходим, если он полностью вода. Так корабль
  // держится открытого моря и не режет острова.
  private buildWaterGrid() {
    this.ck = Math.max(1, Math.round(this.w / 400));
    const k = this.ck;
    this.cw = Math.ceil(this.w / k);
    this.ch = Math.ceil(this.h / k);
    this.cwater = new Uint8Array(this.cw * this.ch);
    for (let cy = 0; cy < this.ch; cy++) {
      for (let cx = 0; cx < this.cw; cx++) {
        let land = 0;
        let total = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const x = cx * k + dx;
            const y = cy * k + dy;
            if (x >= this.w || y >= this.h) continue;
            total++;
            if (this.terrain[y * this.w + x]) land++;
          }
        }
        this.cwater[cy * this.cw + cx] = total > 0 && land === 0 ? 1 : 0;
      }
    }
  }

  // Путь по воде между грубыми клетками (BFS, 8 направлений). Возвращает
  // список грубых индексов от start к goal или null, если пути нет.
  private waterPath(startC: number, goalC: number): number[] | null {
    if (this.cwater[startC] !== 1 || this.cwater[goalC] !== 1) return null;
    const n = this.cw * this.ch;
    const prev = new Int32Array(n).fill(-2);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    queue[tail++] = startC;
    prev[startC] = -1;
    while (head < tail) {
      const c = queue[head++];
      if (c === goalC) break;
      const cx = c % this.cw;
      const cy = (c / this.cw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cw || ny >= this.ch) continue;
          const nc = ny * this.cw + nx;
          if (this.cwater[nc] !== 1 || prev[nc] !== -2) continue;
          // диагональ не должна срезать угол суши
          if (dx && dy) {
            if (this.cwater[cy * this.cw + nx] !== 1 && this.cwater[ny * this.cw + cx] !== 1)
              continue;
          }
          prev[nc] = c;
          queue[tail++] = nc;
        }
      }
    }
    if (prev[goalC] === -2) return null;
    const path: number[] = [];
    for (let c = goalC; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    return path;
  }

  // ближайшая грубая водная клетка к точке (cx,cy) в клетках карты
  private nearestWaterCoarse(x: number, y: number): number {
    const k = this.ck;
    const bx = Math.min(this.cw - 1, (x / k) | 0);
    const by = Math.min(this.ch - 1, (y / k) | 0);
    for (let r = 0; r < Math.max(this.cw, this.ch); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= this.cw || ny >= this.ch) continue;
          if (this.cwater[ny * this.cw + nx] === 1) return ny * this.cw + nx;
        }
      }
    }
    return -1;
  }

  // Связные материки/острова (4-связность) — чтобы понять, нужен ли морской
  // десант: если клетка на другом острове, чем территория игрока, шлём лодку
  private computeLandIds() {
    this.landId.fill(-1);
    const stack: number[] = [];
    let id = 0;
    for (let s = 0; s < this.cells; s++) {
      if (!this.terrain[s] || this.landId[s] >= 0) continue;
      stack.length = 0;
      stack.push(s);
      this.landId[s] = id;
      while (stack.length) {
        const c = stack.pop()!;
        this.forNeighbors(c, (n) => {
          if (this.terrain[n] && this.landId[n] < 0) {
            this.landId[n] = id;
            stack.push(n);
          }
        });
      }
      id++;
    }
  }

  addBots(difficulty: Difficulty) {
    this.difficulty = difficulty;
    const cfg = DIFFICULTY[difficulty];
    for (const name of weakNames(WEAK_COUNT)) {
      this.addPlayer(name, {
        bot: true,
        passive: true,
        growthMul: WEAK_GROWTH,
        maxMul: WEAK_MAX,
      });
    }
    for (const name of pickShuffled(STRONG_NAMES, STRONG_COUNT)) {
      this.addPlayer(name, { bot: true, strong: true, growthMul: cfg.strongMul });
    }
  }

  private genTerrain() {
    if (this.mapType === 'earth') {
      this.terrain = earthTerrain();
      this.landCount = 0;
      for (let c = 0; c < this.cells; c++) if (this.terrain[c]) this.landCount++;
      return;
    }
    // Случайные континенты: зёрна + рост фронтира (модель Эдена)
    this.landCount = 0;
    const target = this.cells * LAND_RATIO;
    const frontier: number[] = [];
    const margin = 0.1;
    for (let s = 0; s < 14; s++) {
      const x = Math.floor(this.w * (margin + Math.random() * (1 - 2 * margin)));
      const y = Math.floor(this.h * (margin + Math.random() * (1 - 2 * margin)));
      const c = y * this.w + x;
      if (!this.terrain[c]) {
        this.terrain[c] = 1;
        this.landCount++;
        frontier.push(c);
      }
    }
    while (this.landCount < target && frontier.length) {
      const idx = (Math.random() * frontier.length) | 0;
      const c = frontier[idx];
      const free: number[] = [];
      this.forNeighbors(c, (n) => {
        if (!this.terrain[n]) free.push(n);
      });
      if (!free.length) {
        frontier[idx] = frontier[frontier.length - 1];
        frontier.pop();
        continue;
      }
      const n = free[(Math.random() * free.length) | 0];
      this.terrain[n] = 1;
      this.landCount++;
      frontier.push(n);
    }
    // типы местности: плавные градиенты через многослойный шум
    const ox = Math.random() * 500;
    const oy = Math.random() * 500;
    for (let c = 0; c < this.cells; c++) {
      if (!this.terrain[c]) continue;
      const x = c % this.w;
      const y = (c / this.w) | 0;
      const polar = Math.min(y, this.h - 1 - y) / this.h;
      const snow = smoothstep(0.11, 0.03, polar) + (fbm(x / 22 + ox, y / 22 + oy) - 0.5) * 0.55;
      if (snow > 0.55) {
        this.terrain[c] = 4; // снег
      } else if (fbm(x / 40 + ox * 2, y / 40 + oy) > 0.63) {
        this.terrain[c] = 3; // камень
      } else if (fbm(x / 48 + oy * 2, y / 48 + ox) < 0.37) {
        this.terrain[c] = 2; // песок
      }
    }
  }

  private forNeighbors(c: number, fn: (n: number) => void) {
    const x = c % this.w;
    if (x > 0) fn(c - 1);
    if (x < this.w - 1) fn(c + 1);
    if (c >= this.w) fn(c - this.w);
    if (c < this.cells - this.w) fn(c + this.w);
  }

  addPlayer(
    name: string,
    opts: {
      bot?: boolean;
      strong?: boolean;
      passive?: boolean;
      growthMul?: number;
      maxMul?: number;
    } = {}
  ): Player {
    const p: Player = {
      id: this.nextId++,
      name,
      troops: SPAWN_TROOPS,
      maxTroops: SPAWN_TROOPS,
      cells: 0,
      alive: true,
      spawned: false,
      bot: opts.bot ?? false,
      strong: opts.strong ?? false,
      passive: opts.passive ?? false,
      growthMul: opts.growthMul ?? 1,
      maxMul: opts.maxMul ?? 1,
      money: START_MONEY,
      thinkAt: this.tickNo + 20 + ((Math.random() * 30) | 0),
      spawnTick: this.tickNo,
    };
    this.players.set(p.id, p);
    this.cellsOf.set(p.id, []);
    if (p.bot) this.spawnRandom(p); // люди выбирают точку старта сами
    return p;
  }

  // Клетки игрока без «протухших» записей; при сильном засорении — уплотняем
  private playerCells(id: number): number[] {
    const arr = this.cellsOf.get(id);
    if (!arr) return [];
    const p = this.players.get(id);
    if (p && arr.length > p.cells * 2 + 32) {
      const fresh = arr.filter((c) => this.owners[c] === id);
      this.cellsOf.set(id, fresh);
      return fresh;
    }
    return arr;
  }

  // Можно ли высадиться в клетку: суша, не занята людьми, вокруг нет людей.
  // allowBots — разрешает вырезать плацдарм из территории ботов
  private canPlace(cell: number, clearance: number, allowBots: boolean): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    const o = this.owners[cell];
    if (o !== 0 && !(allowBots && this.players.get(o)?.bot)) return false;
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    for (let dy = -clearance; dy <= clearance; dy++) {
      for (let dx = -clearance; dx <= clearance; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const oo = this.owners[y * this.w + x];
        if (oo === 0) continue;
        if (!allowBots) return false;
        const op = this.players.get(oo);
        if (op && !op.bot) return false; // рядом человек — нельзя
      }
    }
    return true;
  }

  // Игрок кликнул точку старта. true = успех
  trySpawn(playerId: number, cell: number): boolean {
    const p = this.players.get(playerId);
    if (!p?.alive || p.spawned) return false;
    if (!this.canPlace(cell, 5, true)) return false;
    // плацдарм радиуса 4 (отбираем нейтраль и ботов), полные войска с ранним
    // запасом — чтобы высадка на забитой карте не съедалась мгновенно
    this.claimDisk(cell % this.w, (cell / this.w) | 0, p.id, true, 4);
    p.spawned = true;
    p.spawnTick = this.tickNo;
    p.thinkAt = this.tickNo + 5; // расширяться начинаем сразу, без застоя
    p.troops = (150 + p.cells * 12) * p.maxMul + 1500;
    return true;
  }

  // Случайный спавн: для ботов и для людей, не успевших выбрать за таймер
  spawnRandom(p: Player) {
    for (let attempt = 0; attempt < 6000; attempt++) {
      const c = (Math.random() * this.cells) | 0;
      // сначала ищем чистое место, потом теснее, в крайнем случае — по ботам
      const clearance = attempt < 2000 ? 7 : 4;
      const allowBots = attempt >= 4000;
      if (!this.canPlace(c, clearance, allowBots)) continue;
      this.claimDisk(c % this.w, (c / this.w) | 0, p.id, allowBots);
      p.spawned = true;
      p.spawnTick = this.tickNo;
      p.thinkAt = this.tickNo + 5; // расширяться начинаем сразу
      return;
    }
  }

  private claimDisk(cx: number, cy: number, id: number, takeBots = false, radius = 3) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const n = y * this.w + x;
        if (!this.terrain[n]) continue;
        const o = this.owners[n];
        if (o === 0 || (takeBots && this.players.get(o)?.bot)) this.setOwner(n, id);
      }
    }
  }

  removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    for (const c of this.playerCells(id)) {
      if (this.owners[c] === id) this.setOwner(c, 0);
    }
    this.attacks = this.attacks.filter((a) => a.player !== id);
    this.boats = this.boats.filter((b) => b.player !== id);
    this.buildings = this.buildings.filter((b) => b.owner !== id);
    this.tradeShips = this.tradeShips.filter((s) => s.owner !== id);
    this.clearRelations(id);
    this.fortDirty = true;
    this.cellsOf.delete(id);
    this.players.delete(id);
  }

  // убрать все союзы/вражду игрока и уведомить бывших партнёров
  private clearRelations(id: number) {
    for (const other of this.allies.get(id) ?? []) {
      this.allies.get(other)?.delete(id);
      this.relChanged.add(other);
    }
    for (const other of this.hostiles.get(id) ?? []) {
      this.hostiles.get(other)?.delete(id);
      this.relChanged.add(other);
    }
    this.allies.delete(id);
    this.hostiles.delete(id);
  }

  private setOwner(c: number, owner: number) {
    const prev = this.owners[c];
    if (prev === owner) return;
    if (prev > 0) {
      const p = this.players.get(prev);
      if (p) {
        p.cells--;
        if (p.cells <= 0 && p.alive && p.spawned) this.kill(p, owner);
      }
    }
    if (owner > 0) {
      const p = this.players.get(owner);
      if (p) p.cells++;
      const list = this.cellsOf.get(owner);
      if (list) list.push(c); // удаление ленивое — фильтруется при чтении
    }
    this.owners[c] = owner;
    this.changed.set(c, owner);
  }

  private kill(p: Player, killerId = 0) {
    p.alive = false;
    p.troops = 0;
    this.deaths.push(p.id);
    this.attacks = this.attacks.filter((a) => a.player !== p.id);
    this.boats = this.boats.filter((b) => b.player !== p.id);
    // казна павшего достаётся тому, кто захватил его последнюю клетку
    const killer = killerId > 0 ? this.players.get(killerId) : undefined;
    if (killer?.alive) killer.money += p.money;
    p.money = 0;
    this.tradeShips = this.tradeShips.filter((s) => s.owner !== p.id);
    this.clearRelations(p.id);
    // здания НЕ сносим тут: их клетки уже захвачены, и checkBuildings корректно
    // взорвёт щит (обычный мгновенно, прокачанный через фитиль)
    this.fortDirty = true;
  }

  // Сухопутная атака (ЛКМ): наступление по суше от общей границы
  launchAttackCell(playerId: number, cell: number, ratio: number) {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return;
    const targetOwner = this.owners[cell];
    if (targetOwner === playerId) return;
    if (targetOwner > 0 && this.relation(playerId, targetOwner) === 'allied') return;
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return;
    const r = Math.min(1, Math.max(0.05, ratio || 0));
    this.launchAttackOwner(playerId, targetOwner, Math.floor(p.troops * r));
  }

  // Морское вторжение (ПКМ): десант к берегу цели. true = отправлен
  launchInvasion(playerId: number, cell: number, ratio: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    const to = this.owners[cell];
    if (to === playerId) return false;
    if (to > 0 && this.relation(playerId, to) === 'allied') return false;
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return false;
    const r = Math.min(1, Math.max(0.05, ratio || 0));
    return this.launchBoat(playerId, cell, Math.floor(p.troops * r));
  }

  // ближайшая береговая клетка игрока (сосед — вода) к точке (tx,ty)
  private nearestCoast(playerId: number, tx: number, ty: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < this.cells; c++) {
      if (this.owners[c] !== playerId) continue;
      let coastal = false;
      this.forNeighbors(c, (n) => {
        if (!this.terrain[n]) coastal = true;
      });
      if (!coastal) continue;
      const dx = (c % this.w) - tx;
      const dy = ((c / this.w) | 0) - ty;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // берег материка клетки targetCell, ближайший к (fromX,fromY) — точка высадки
  private landingShore(targetCell: number, fromX: number, fromY: number): number {
    const land = this.landId[targetCell];
    let best = targetCell;
    let bestD = Infinity;
    for (let c = 0; c < this.cells; c++) {
      if (this.landId[c] !== land) continue;
      let coastal = false;
      this.forNeighbors(c, (n) => {
        if (!this.terrain[n]) coastal = true;
      });
      if (!coastal) continue;
      const dx = (c % this.w) - fromX;
      const dy = ((c / this.w) | 0) - fromY;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // Морской десант: маршрут по воде от берега игрока к берегу цели (в обход суши)
  private launchBoat(playerId: number, targetCell: number, troops: number): boolean {
    const p = this.players.get(playerId);
    if (!p?.alive || troops < 10) return false;
    const tx = targetCell % this.w;
    const ty = (targetCell / this.w) | 0;
    // берег высадки — кромка целевого материка у самой точки клика (а не у
    // нашего берега), чтобы высаживаться туда, куда целишься, в т.ч. на свой
    // же остров рядом с врагом
    const landCell = this.landingShore(targetCell, tx, ty);
    const lx = landCell % this.w;
    const ly = (landCell / this.w) | 0;
    // отправная точка — ближайший берег игрока именно к точке высадки
    const src = this.nearestCoast(playerId, lx, ly);
    if (src < 0) return false; // нет выхода к морю
    const sx = src % this.w;
    const sy = (src / this.w) | 0;
    // маршрут по грубой водной сетке
    const startC = this.nearestWaterCoarse(sx, sy);
    const goalC = this.nearestWaterCoarse(lx, ly);
    if (startC < 0 || goalC < 0) return false;
    const coarse = this.waterPath(startC, goalC);
    if (!coarse) return false; // морем не добраться
    // грубые клетки → центры карты; берём каждую 2-ю, концы — реальные берега
    const raw: number[] = [sx + 0.5, sy + 0.5];
    for (let i = 0; i < coarse.length; i += 2) {
      const cc = coarse[i];
      raw.push((cc % this.cw) * this.ck + this.ck / 2, ((cc / this.cw) | 0) * this.ck + this.ck / 2);
    }
    raw.push(lx + 0.5, ly + 0.5);
    // сглаживаем ломаный путь (Чайкин 2×) — плавная кривая без изломов
    const path = chaikin(chaikin(raw));
    // накопленная длина маршрута
    const cum: number[] = [0];
    for (let i = 2; i < path.length; i += 2) {
      cum.push(cum[cum.length - 1] + Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]));
    }
    p.troops -= troops;
    this.boats.push({
      id: this.nextBoatId++,
      player: playerId,
      target: this.owners[landCell],
      troops,
      path,
      cum,
      totalLen: cum[cum.length - 1] || 1,
      traveled: 0,
      returning: false,
      landCell,
      x: sx + 0.5,
      y: sy + 0.5,
    });
    return true;
  }

  // Отзыв десанта: лодка поворачивает и возвращается к точке отправления
  recallBoat(playerId: number, boatId: number) {
    const b = this.boats.find((x) => x.id === boatId && x.player === playerId);
    if (b) b.returning = true;
  }

  private stepBoats() {
    for (const b of this.boats) {
      const p = this.players.get(b.player);
      if (!p?.alive) {
        b.troops = 0;
        continue;
      }
      b.traveled += b.returning ? -BOAT_SPEED : BOAT_SPEED;
      if (b.returning && b.traveled <= 0) {
        // вернулась домой — войска возвращаются игроку
        p.troops = Math.min(p.maxTroops, p.troops + b.troops);
        b.troops = 0;
        continue;
      }
      if (!b.returning && b.traveled >= b.totalLen) {
        this.landBoat(b);
        b.troops = 0;
        continue;
      }
      // позиция по пройденной дистанции вдоль ломаного маршрута
      const d = Math.max(0, Math.min(b.totalLen, b.traveled));
      let seg = 0;
      while (seg < b.cum.length - 2 && b.cum[seg + 1] < d) seg++;
      const segLen = (b.cum[seg + 1] - b.cum[seg]) || 1;
      const t = (d - b.cum[seg]) / segLen;
      const ax = b.path[seg * 2];
      const ay = b.path[seg * 2 + 1];
      const bx = b.path[(seg + 1) * 2];
      const by = b.path[(seg + 1) * 2 + 1];
      b.x = ax + (bx - ax) * t;
      b.y = ay + (by - ay) * t;
    }
    this.boats = this.boats.filter((b) => b.troops >= 1);
  }

  // Высадка на берег: плацдарм у кромки + наступление вглубь
  private landBoat(b: Boat) {
    const p = this.players.get(b.player);
    if (!p?.alive) return;
    const landCell = this.terrain[b.landCell] ? b.landCell : -1;
    if (landCell < 0) return;
    const cx = landCell % this.w;
    const cy = (landCell / this.w) | 0;
    const target = this.owners[landCell];
    // плацдарм: диск радиуса 2 переходит десанту (отбираем у берега-цели)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 4) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const n = y * this.w + x;
        if (this.terrain[n]) this.setOwner(n, b.player);
      }
    }
    p.troops = Math.min(999999, p.troops + Math.floor(b.troops * 0.3));
    // остаток десанта продолжает наступление вглубь берега
    this.launchAttackOwner(b.player, target, Math.floor(b.troops * 0.6));
  }

  // Разрешено ли строить в клетке: своя суша и НЕ граница (все соседи — свои),
  // и там ещё нет здания. Клиент по этой же логике красит предпросмотр.
  canBuildAt(playerId: number, cell: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    if (this.owners[cell] !== playerId) return false;
    let border = false;
    this.forNeighbors(cell, (n) => {
      if (this.owners[n] !== playerId) border = true;
    });
    if (border) return false;
    return !this.buildings.some((b) => b.cell === cell);
  }

  private hqCount(playerId: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === playerId && b.type === 'hq') n++;
    return n;
  }

  // Порт можно ставить на своей прибрежной клетке (рядом вода), без вражеских
  // соседей по суше и без здания в клетке
  private canBuildPort(playerId: number, cell: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    if (this.owners[cell] !== playerId) return false;
    let coastal = false;
    let enemyAdj = false;
    this.forNeighbors(cell, (n) => {
      if (!this.terrain[n]) coastal = true;
      else if (this.owners[n] !== playerId) enemyAdj = true;
    });
    if (!coastal || enemyAdj) return false;
    return !this.buildings.some((b) => b.cell === cell);
  }

  // ближайшая своя прибрежная клетка, куда можно поставить порт, в радиусе maxR
  // от указанной точки (порт «притягивается» к берегу)
  private nearestOwnCoast(playerId: number, cell: number, maxR: number): number {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const maxR2 = maxR * maxR;
    let best = -1;
    let bestD = Infinity;
    for (let dy = -maxR; dy <= maxR; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.h) continue;
      for (let dx = -maxR; dx <= maxR; dx++) {
        const d = dx * dx + dy * dy;
        if (d > maxR2 || d >= bestD) continue;
        const x = cx + dx;
        if (x < 0 || x >= this.w) continue;
        const c = y * this.w + x;
        if (!this.canBuildPort(playerId, c)) continue;
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // ближайший свой порт в радиусе PORT_RADIUS от клетки (для апгрейда вместо новой)
  private nearbyPort(playerId: number, cell: number): Building | undefined {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const r2 = PORT_RADIUS * PORT_RADIUS;
    return this.buildings.find(
      (b) =>
        b.type === 'port' &&
        b.owner === playerId &&
        (b.cell % this.w - cx) ** 2 + ((b.cell / this.w | 0) - cy) ** 2 <= r2
    );
  }

  // Постройка здания. Возвращает код ошибки или null при успехе.
  build(playerId: number, bt: BuildingType, cell: number): string | null {
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return 'Нельзя строить';
    if (bt === 'port') {
      // клик рядом с существующим портом — апгрейд, а не новый порт
      const near = this.nearbyPort(playerId, cell);
      if (near) return this.upgrade(playerId, near.cell);
      // притягиваем к ближайшему своему берегу (клик в радиусе PORT_RADIUS от него)
      const shore = this.canBuildPort(playerId, cell)
        ? cell
        : this.nearestOwnCoast(playerId, cell, PORT_RADIUS);
      if (shore < 0) return 'Рядом нет своего берега';
      if (p.money < PORT_BUILD_COST) return 'Недостаточно денег';
      p.money -= PORT_BUILD_COST;
      this.buildings.push({
        id: this.nextBuildingId++,
        owner: playerId,
        cell: shore,
        type: 'port',
        readyTick: this.tickNo + PORT_BUILD_TICKS,
        level: 1,
        fuseTick: 0,
        upStart: 0,
        upEnd: 0,
        nextShipTick: 0,
        ships: 0,
      });
      return null;
    }
    if (!this.canBuildAt(playerId, cell)) return 'Здесь строить нельзя';
    const cost = hqCost(this.hqCount(playerId));
    if (p.money < cost) return 'Недостаточно денег';
    p.money -= cost;
    this.buildings.push({
      id: this.nextBuildingId++,
      owner: playerId,
      cell,
      type: bt,
      readyTick: this.tickNo + HQ_BUILD_TICKS,
      level: 1,
      fuseTick: 0,
      upStart: 0,
      upEnd: 0,
      nextShipTick: 0,
      ships: 0,
    });
    // укрепление появится, когда постройка завершится (см. tick)
    return null;
  }

  // Прокачка: штаб (до 3 ур.) или порт (бесконечно) — оба с таймером и прогрессом
  upgrade(playerId: number, cell: number): string | null {
    const p = this.players.get(playerId);
    if (!p?.alive) return 'Нельзя';
    const b = this.buildings.find((x) => x.cell === cell && x.owner === playerId);
    if (!b) return 'Здесь нет вашего здания';
    if (this.tickNo < b.readyTick) return 'Ещё строится';
    if (b.type === 'port') {
      const cost = portUpgradeCost(b.level + 1);
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      b.level++; // порт апгрейдится мгновенно, уровней сколько угодно
      return null;
    }
    if (b.upEnd > 0) return 'Уже улучшается';
    if (b.level >= MAX_HQ_LEVEL) return 'Максимальный уровень';
    const toLevel = b.level + 1;
    const cost = hqUpgradeCost(toLevel);
    if (p.money < cost) return 'Недостаточно денег';
    p.money -= cost;
    b.upStart = this.tickNo;
    b.upEnd = this.tickNo + hqUpgradeTicks(toLevel);
    return null;
  }

  // --- Связи (союзы/вражда) ---
  relation(a: number, b: number): 'neutral' | 'hostile' | 'allied' {
    if (this.allies.get(a)?.has(b)) return 'allied';
    if (this.hostiles.get(a)?.has(b)) return 'hostile';
    return 'neutral';
  }

  private setRel(map: Map<number, Set<number>>, a: number, b: number, on: boolean) {
    if (on) {
      (map.get(a) ?? map.set(a, new Set()).get(a)!).add(b);
      (map.get(b) ?? map.set(b, new Set()).get(b)!).add(a);
    } else {
      map.get(a)?.delete(b);
      map.get(b)?.delete(a);
    }
  }

  // отметить пару враждебной (при атаке); только если задействован человек
  private markHostile(a: number, b: number) {
    if (a === b) return;
    const pa = this.players.get(a);
    const pb = this.players.get(b);
    if (!pa || !pb || (pa.bot && pb.bot)) return; // бот-vs-бот игнорируем
    if (this.relation(a, b) === 'allied') return; // союзников не трогаем
    if (this.relation(a, b) === 'hostile') return;
    this.setRel(this.hostiles, a, b, true);
    this.relChanged.add(a).add(b);
  }

  // предложить союз владельцу клетки. Боты принимают сразу; людям — уведомление.
  proposeAlliance(fromId: number, cell: number): { toId: number; auto: boolean } | null {
    const toId = this.owners[cell];
    if (toId <= 0 || toId === fromId) return null;
    const to = this.players.get(toId);
    if (!to?.alive) return null;
    if (this.relation(fromId, toId) === 'allied') return null;
    if (to.bot) {
      this.acceptAlliance(fromId, toId);
      return { toId, auto: true };
    }
    return { toId, auto: false };
  }

  acceptAlliance(a: number, b: number) {
    this.setRel(this.hostiles, a, b, false); // союз снимает вражду
    this.setRel(this.allies, a, b, true);
    this.relChanged.add(a).add(b);
  }

  breakAlliance(a: number, cell: number) {
    const b = this.owners[cell];
    if (b <= 0) return;
    this.setRel(this.allies, a, b, false); // назад в нейтралитет
    this.relChanged.add(a).add(b);
  }

  // списки для клиента (относительно игрока)
  relationsFor(id: number): { allies: number[]; enemies: number[] } {
    return {
      allies: [...(this.allies.get(id) ?? [])],
      enemies: [...(this.hostiles.get(id) ?? [])],
    };
  }

  // --- Трейд-корабли ---
  // Маршрут по воде между двумя портовыми (прибрежными) клетками; кэшируется.
  private waterRoute(fromCell: number, toCell: number) {
    const key = fromCell * this.cells + toCell;
    const cached = this.routeCache.get(key);
    if (cached !== undefined) return cached;
    const sx = fromCell % this.w;
    const sy = (fromCell / this.w) | 0;
    const lx = toCell % this.w;
    const ly = (toCell / this.w) | 0;
    let result: { path: number[]; cum: number[]; totalLen: number } | null = null;
    const startC = this.nearestWaterCoarse(sx, sy);
    const goalC = this.nearestWaterCoarse(lx, ly);
    if (startC >= 0 && goalC >= 0) {
      const coarse = this.waterPath(startC, goalC);
      if (coarse) {
        const raw: number[] = [sx + 0.5, sy + 0.5];
        for (let i = 0; i < coarse.length; i += 2) {
          const cc = coarse[i];
          raw.push((cc % this.cw) * this.ck + this.ck / 2, ((cc / this.cw) | 0) * this.ck + this.ck / 2);
        }
        raw.push(lx + 0.5, ly + 0.5);
        const path = chaikin(chaikin(raw));
        const cum: number[] = [0];
        for (let i = 2; i < path.length; i += 2) {
          cum.push(cum[cum.length - 1] + Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]));
        }
        result = { path, cum, totalLen: cum[cum.length - 1] || 1 };
      }
    }
    this.routeCache.set(key, result);
    return result;
  }

  // порт-получатель для кораблей из from: только порт ДРУГОГО не-враждебного
  // игрока (в свои же порты корабль не ходит)
  private pickTradeDest(from: Building): Building | null {
    const cands = this.buildings.filter(
      (b) =>
        b.type === 'port' &&
        b.owner !== from.owner &&
        this.tickNo >= b.readyTick &&
        this.relation(from.owner, b.owner) !== 'hostile'
    );
    if (!cands.length) return null;
    return cands[(Math.random() * cands.length) | 0];
  }

  // выпуск торговых кораблей из портов (по одному раз в PORT_SHIP_INTERVAL,
  // одновременно не больше shipsForLevel(level))
  private spawnTradeShips() {
    for (const b of this.buildings) {
      if (b.type !== 'port' || this.tickNo < b.readyTick) continue;
      if (this.tickNo < b.nextShipTick) continue;
      b.nextShipTick = this.tickNo + PORT_SHIP_INTERVAL;
      const active = this.tradeShips.reduce(
        (n, s) => (s.portCell === b.cell && s.owner === b.owner ? n + 1 : n),
        0
      );
      if (active >= shipsForLevel(b.level)) continue;
      const dest = this.pickTradeDest(b);
      if (!dest) continue;
      const route = this.waterRoute(b.cell, dest.cell);
      if (!route) continue;
      // дальние рейсы прибыльнее: +100% на каждые ~800 клеток пути
      const distFactor = 1 + route.totalLen / 800;
      this.tradeShips.push({
        id: this.nextShipId++,
        owner: b.owner,
        portCell: b.cell,
        path: route.path,
        cum: route.cum,
        totalLen: route.totalLen,
        traveled: 0,
        returning: false,
        payout: Math.round(tradeValue(b.level) * distFactor),
        done: false,
        x: (b.cell % this.w) + 0.5,
        y: ((b.cell / this.w) | 0) + 0.5,
      });
    }
  }

  private stepTradeShips() {
    for (const s of this.tradeShips) {
      const p = this.players.get(s.owner);
      // домашний порт ещё существует и наш?
      const home = this.buildings.find(
        (b) => b.cell === s.portCell && b.owner === s.owner && b.type === 'port'
      );
      if (!p?.alive || !home) {
        s.done = true;
        continue;
      }
      s.traveled += s.returning ? -TRADE_SPEED : TRADE_SPEED;
      if (!s.returning && s.traveled >= s.totalLen) {
        p.money += s.payout; // дошёл до чужого порта — выплата
        this.recordEarning(s);
        s.returning = true;
        s.traveled = s.totalLen;
      } else if (s.returning && s.traveled <= 0) {
        p.money += s.payout; // вернулся домой — ещё выплата
        this.recordEarning(s);
        s.done = true;
        continue;
      }
      const d = Math.max(0, Math.min(s.totalLen, s.traveled));
      let seg = 0;
      while (seg < s.cum.length - 2 && s.cum[seg + 1] < d) seg++;
      const segLen = s.cum[seg + 1] - s.cum[seg] || 1;
      const t = (d - s.cum[seg]) / segLen;
      const ax = s.path[seg * 2];
      const ay = s.path[seg * 2 + 1];
      const bx = s.path[(seg + 1) * 2];
      const by = s.path[(seg + 1) * 2 + 1];
      s.x = ax + (bx - ax) * t;
      s.y = ay + (by - ay) * t;
    }
    if (this.tradeShips.some((s) => s.done)) {
      this.tradeShips = this.tradeShips.filter((s) => !s.done);
    }
  }

  // фиксируем заработок для всплывашки — только у людей (боту не показываем);
  // деньги получает домашний порт корабля → всплывашка всегда над ним (и на
  // заходе в чужой порт, и на возврате в свой)
  private recordEarning(s: TradeShip) {
    if (this.players.get(s.owner)?.bot) return;
    const x = (s.portCell % this.w) + 0.5;
    const y = ((s.portCell / this.w) | 0) + 0.5;
    // несколько выплат одного порта за интервал — суммируем в одну всплывашку
    const e = this.tradeEarnings.find((z) => z.x === x && z.y === y && z.owner === s.owner);
    if (e) e.amount += s.payout;
    else this.tradeEarnings.push({ x, y, amount: s.payout, owner: s.owner });
  }

  tradeShipsPub(): TradeShipPub[] {
    return this.tradeShips.map((s) => ({
      id: s.id,
      owner: s.owner,
      x: s.x,
      y: s.y,
    }));
  }

  // Захват/фитиль/взрыв щитов. Вызывается каждый тик (зданий немного).
  private checkBuildings() {
    const remove = new Set<Building>();
    const explosions: { cell: number; level: number }[] = [];
    for (const b of this.buildings) {
      if (this.tickNo < b.readyTick) continue; // ещё строится — неуязвим
      // порт: при захвате клетки переходит захватчику (нейтраль/взрыв — сносится)
      if (b.type === 'port') {
        const now = this.owners[b.cell];
        if (now !== b.owner) {
          if (now > 0 && this.players.get(now)?.alive) {
            b.owner = now; // новый хозяин; корабли прежнего владельца сами исчезнут
            b.nextShipTick = this.tickNo + PORT_SHIP_INTERVAL;
          } else {
            remove.add(b);
          }
        }
        continue;
      }
      // завершение апгрейда
      if (b.upEnd > 0 && this.tickNo >= b.upEnd) {
        b.level++;
        b.upStart = 0;
        b.upEnd = 0;
      }
      const captured = this.owners[b.cell] !== b.owner;
      if (!captured) {
        // клетка снова у владельца — отбили, фитиль сбрасывается, всё как было
        if (b.fuseTick > 0) {
          b.fuseTick = 0;
          this.fortDirty = true;
        }
        continue;
      }
      if (b.level < 2) {
        remove.add(b); // обычный щит — взрывается мгновенно (просто сносится)
        continue;
      }
      // прокачанный: 10с фитиль, потом взрыв с уроном по области
      if (b.fuseTick === 0) {
        b.fuseTick = this.tickNo + HQ_FUSE_TICKS;
        this.fortDirty = true; // укрепление гаснет при захвате
      } else if (this.tickNo >= b.fuseTick) {
        explosions.push({ cell: b.cell, level: b.level });
        remove.add(b);
      }
    }
    // выполняем взрывы: урон по территории/армии + снос всех зданий в радиусе
    for (const ex of explosions) {
      this.explode(ex.cell, ex.level);
      const R = ex.level >= 3 ? HQ_EXPLODE_RADIUS * 2 : HQ_EXPLODE_RADIUS;
      const R2 = R * R;
      const cx = ex.cell % this.w;
      const cy = (ex.cell / this.w) | 0;
      for (const b of this.buildings) {
        const dx = (b.cell % this.w) - cx;
        const dy = ((b.cell / this.w) | 0) - cy;
        if (dx * dx + dy * dy <= R2) remove.add(b); // любое здание в радиусе — снесено
      }
    }
    if (remove.size) {
      this.buildings = this.buildings.filter((b) => !remove.has(b));
      this.fortDirty = true;
    }
  }

  // Взрыв прокачанного щита: обнуляет территорию вокруг (урон по области) и
  // отнимает у каждого задетого игрока долю армии, равную доле уничтоженной
  // территории от его общей
  private explode(cell: number, level: number) {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const R = level >= 3 ? HQ_EXPLODE_RADIUS * 2 : HQ_EXPLODE_RADIUS; // 3 ур. — вдвое больше
    const R2 = R * R;
    const inBlast: number[] = [];
    const lost = new Map<number, number>(); // владелец -> сколько клеток теряет
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.h) continue;
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R2) continue;
        const x = cx + dx;
        if (x < 0 || x >= this.w) continue;
        const n = y * this.w + x;
        const o = this.owners[n];
        if (this.terrain[n] && o !== 0) {
          inBlast.push(n);
          lost.set(o, (lost.get(o) || 0) + 1);
        }
      }
    }
    // урон по армии: 3 ур. — 25% от текущих войск, иначе доля уничтоженной
    // территории от всей (считаем до обнуления клеток)
    for (const [owner, n] of lost) {
      const p = this.players.get(owner);
      if (p && p.cells > 0) {
        const frac = level >= 3 ? 0.25 : n / p.cells;
        p.troops = Math.max(0, p.troops - p.troops * frac);
      }
    }
    for (const n of inBlast) this.setOwner(n, 0);
  }

  // Пересбор поля укреплений: каждый штаб штампует диск своего владельца.
  // Дёшево и делается только при изменении зданий.
  private rebuildFort() {
    this.fortField.fill(0);
    this.fortLevel.fill(0);
    const R = HQ_RADIUS;
    const R2 = R * R;
    for (const b of this.buildings) {
      if (this.tickNo < b.readyTick || b.type === 'port') continue; // строится/порт — не укрепляет
      const cx = b.cell % this.w;
      const cy = (b.cell / this.w) | 0;
      for (let dy = -R; dy <= R; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= this.h) continue;
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R2) continue;
          const x = cx + dx;
          if (x < 0 || x >= this.w) continue;
          const n = y * this.w + x;
          // сильнейший штаб на клетке определяет владельца и уровень защиты
          if (b.level > this.fortLevel[n]) {
            this.fortLevel[n] = b.level;
            this.fortField[n] = b.owner;
          }
        }
      }
    }
    this.fortDirty = false;
  }

  launchAttackOwner(playerId: number, targetOwner: number, troops: number) {
    const p = this.players.get(playerId);
    if (!p?.alive) return;
    // на союзников нападать нельзя (сначала расторгнуть союз)
    if (targetOwner > 0 && this.relation(playerId, targetOwner) === 'allied') return;
    troops = Math.min(troops, Math.floor(p.troops));
    if (troops < 10) return;
    p.troops -= troops;
    // атака на игрока делает пару враждебной (торговля прекращается)
    if (targetOwner > 0) this.markHostile(playerId, targetOwner);
    const existing = this.attacks.find((a) => a.player === playerId && a.target === targetOwner);
    if (existing) existing.troops += troops;
    else {
      this.attacks.push({
        player: playerId,
        target: targetOwner,
        troops,
        frontier: new Set(),
        rescanned: false,
      });
    }
  }

  tick() {
    this.tickNo++;
    // здание завершилось на этом тике — пересобрать поле укреплений
    for (const b of this.buildings) if (b.readyTick === this.tickNo) this.fortDirty = true;
    this.checkBuildings(); // захват/фитиль/взрыв щитов
    if (this.fortDirty) this.rebuildFort();
    for (const p of this.players.values()) {
      if (!p.alive || !p.spawned) continue;
      // ранний фактор: 1 на старте → 0 через 45с
      const early = Math.max(0, 1 - (this.tickNo - p.spawnTick) / 450);
      // в начале даём запас потолка, чтобы армия росла сразу (а не только
      // территория); к 45с запас исчезает, но реальный потолок уже больше
      p.maxTroops = (150 + p.cells * 12) * p.maxMul + early * 1500;
      // базовый прирост как в рабочем балансе (пропорционален армии)
      const base = Math.max(0.5, p.troops * 0.006 * p.growthMul);
      // логистическое торможение: до 70% максимума — полный рост, дальше плавно
      const frac = p.maxTroops > 0 ? p.troops / p.maxTroops : 1;
      const taper =
        frac <= GROWTH_SLOW_FROM
          ? 1
          : Math.max(0.03, 1 - ((frac - GROWTH_SLOW_FROM) / (1 - GROWTH_SLOW_FROM)) * 0.97);
      // при малой армии набираем быстрее: <10% лимита — ×2, 10–30% — ×1.5
      const boost = frac < 0.1 ? 2 : frac < 0.3 ? 1.5 : 1;
      // ранний буст: рост вдвое быстрее + флэт ~+200/с на старте, затухает
      const growth = (base * (1 + early) + early * 20) * taper * boost;
      p.troops = Math.min(p.maxTroops, p.troops + growth);
      // пассивный доход денег — на копейки, от размера территории
      p.money += 0.5 + p.cells * 0.08;
      if (p.bot) {
        if (this.tickNo >= p.thinkAt) this.botThink(p);
      } else if (this.tickNo >= p.thinkAt) {
        // человек: автоматически расширяется в свободную нейтраль за счёт
        // излишка войск, чтобы территория и потолок росли без кликов
        p.thinkAt = this.tickNo + (early > 0 ? 10 : 15);
        if (p.troops > p.maxTroops * 0.5 && this.hasNeutralBorder(p.id)) {
          this.launchAttackOwner(p.id, 0, Math.floor(p.troops * 0.15));
        }
      }
    }
    this.cancelOpposing();
    this.stepBoats();
    this.spawnTradeShips();
    this.stepTradeShips();
    for (const a of this.attacks) this.stepAttack(a);
    this.attacks = this.attacks.filter(
      (a) => a.troops >= 1 && this.players.get(a.player)?.alive
    );
    if (this.winnerId === null) {
      for (const p of this.players.values()) {
        if (p.alive && p.cells > this.landCount * 0.9) {
          this.winnerId = p.id;
          break;
        }
      }
    }
  }

  // Встречные атаки взаимно уничтожаются 1:1 — граница движется в сторону того,
  // кто выделил больше войск, вместо пиксельной каши с двух сторон
  private cancelOpposing() {
    for (const a of this.attacks) {
      if (a.target <= 0 || a.troops < 1) continue;
      const b = this.attacks.find(
        (x) => x.player === a.target && x.target === a.player && x.troops >= 1
      );
      if (!b) continue;
      const m = Math.min(a.troops, b.troops);
      a.troops -= m;
      b.troops -= m;
    }
  }

  private refund(a: Attack, attacker: Player) {
    attacker.troops = Math.min(attacker.maxTroops, attacker.troops + a.troops);
    a.troops = 0;
  }

  // есть ли рядом с игроком свободная нейтраль (выборочная проверка)
  private hasNeutralBorder(id: number): boolean {
    const cells = this.playerCells(id);
    const step = Math.max(1, Math.floor(cells.length / 500));
    for (let i = 0; i < cells.length; i += step) {
      const c = cells[i];
      if (this.owners[c] !== id) continue;
      let found = false;
      this.forNeighbors(c, (n) => {
        if (this.terrain[n] && this.owners[n] === 0) found = true;
      });
      if (found) return true;
    }
    return false;
  }

  private buildFrontier(a: Attack) {
    a.frontier.clear();
    // клетки цели, граничащие с нами = соседи-цели у наших клеток
    for (const c of this.playerCells(a.player)) {
      if (this.owners[c] !== a.player) continue; // протухшая запись
      this.forNeighbors(c, (n) => {
        if (this.terrain[n] && this.owners[n] === a.target) a.frontier.add(n);
      });
    }
  }

  // Волновой захват: фронт поддерживается инкрементально, клетки с большим
  // числом своих соседей берутся первыми — дыры зарастают, граница ровная
  private stepAttack(a: Attack) {
    const attacker = this.players.get(a.player);
    if (!attacker?.alive) {
      a.troops = 0;
      return;
    }
    const enemy = a.target > 0 ? this.players.get(a.target) : undefined;
    if (a.target > 0 && !enemy?.alive) {
      this.refund(a, attacker); // цель уничтожена — вернуть остаток
      return;
    }
    if (a.frontier.size === 0) {
      if (a.rescanned) {
        this.refund(a, attacker); // контакта с целью больше нет
        return;
      }
      this.buildFrontier(a);
      a.rescanned = true;
      if (a.frontier.size === 0) {
        this.refund(a, attacker);
        return;
      }
    }
    // корзины по числу своих соседей: сначала 4 (дыры), потом 3, 2, 1
    const buckets: number[][] = [[], [], [], [], []];
    for (const c of a.frontier) {
      if (this.owners[c] !== a.target) {
        a.frontier.delete(c); // клетку уже кто-то занял
        continue;
      }
      let own = 0;
      this.forNeighbors(c, (n) => {
        if (this.owners[n] === a.player) own++;
      });
      if (own === 0) {
        a.frontier.delete(c); // потеряли контакт с этой клеткой
        continue;
      }
      buckets[own].push(c);
    }
    if (a.frontier.size === 0) return; // пересоберём фронт на следующем тике
    a.rescanned = false;

    // Оборона в 2 раза эффективнее: чтобы убить 1 защитника, гибнут 2
    // нападающих. Захват вражеской клетки стоит атакующему (1 + 2·плотность),
    // защитник теряет плотность (свой гарнизон). На укреплённых штабом клетках
    // — 5:1 (стоимость 1 + 5·плотность). Скорость пропорциональна перевесу.
    let baseCost = NEUTRAL_COST; // цена клетки без штрафа обороны
    let density = 0;
    let waveScale = 1;
    if (enemy) {
      density = enemy.cells > 0 ? enemy.troops / enemy.cells : 0;
      baseCost = 1 + 2 * density;
      if (enemy.troops > 0) {
        waveScale = Math.min(6, Math.max(0.2, a.troops / enemy.troops));
      }
    }
    // остаток меньше даже обычной цены — наступление выдохлось, вернуть войска
    if (a.troops < baseCost) {
      this.refund(a, attacker);
      return;
    }
    let quota = Math.max(1, Math.ceil(a.frontier.size * WAVE_SPEED * waveScale));
    for (let own = 4; own >= 1 && quota > 0; own--) {
      const list = buckets[own];
      while (list.length && quota > 0) {
        const i = (Math.random() * list.length) | 0;
        const c = list[i];
        // укреплена ли клетка штабом её владельца; сопротивление по уровню:
        // 1 ур. — 1:5, 2 ур. — 1:7, 3 ур. — 1:10
        const fortified = enemy && this.fortField[c] === a.target;
        const fl = this.fortLevel[c];
        const mul = fl >= 3 ? 10 : fl === 2 ? 7 : 5;
        const cellCost = fortified ? 1 + mul * density : baseCost;
        if (a.troops < cellCost) {
          // не по карману именно эта клетка — пропускаем её в этом тике
          if (a.troops < baseCost) break;
          list.splice(i, 1);
          continue;
        }
        list[i] = list[list.length - 1];
        list.pop();
        a.frontier.delete(c);
        this.setOwner(c, a.player);
        a.troops -= cellCost;
        if (enemy) enemy.troops = Math.max(0, enemy.troops - density);
        quota--;
        // расширяем фронт на соседей захваченной клетки
        this.forNeighbors(c, (n) => {
          if (this.terrain[n] && this.owners[n] === a.target) a.frontier.add(n);
        });
      }
    }
  }

  private botThink(p: Player) {
    // считаем соседей только по своим клеткам (не по всей карте), с выборкой
    const cells = this.playerCells(p.id);
    const step = Math.max(1, Math.floor(cells.length / 1500));
    const counts = new Map<number, number>();
    for (let i = (Math.random() * step) | 0; i < cells.length; i += step) {
      const c = cells[i];
      if (this.owners[c] !== p.id) continue; // протухшая запись
      this.forNeighbors(c, (n) => {
        if (this.terrain[n] && this.owners[n] !== p.id) {
          const o = this.owners[n];
          counts.set(o, (counts.get(o) || 0) + 1);
        }
      });
    }

    // Пассивный «корм»: думает редко, не нападает на игроков — только вяло
    // расширяется в свободную нейтраль, пока она есть рядом, потом замирает
    if (p.passive) {
      p.thinkAt = this.tickNo + 45 + ((Math.random() * 70) | 0);
      if (p.troops < p.maxTroops * 0.5 || p.troops < 120) return;
      if (!counts.has(0)) return; // нейтрали рядом нет — сидим
      this.launchAttackOwner(p.id, 0, Math.floor(p.troops * 0.5));
      return;
    }

    // Страны изредка строят торговый порт — так у трейда всегда есть партнёры
    // (корабли игрока идут в порты соседей, и наоборот)
    if (
      p.strong &&
      p.money >= PORT_BUILD_COST &&
      !this.buildings.some((b) => b.owner === p.id && b.type === 'port')
    ) {
      for (let i = 0; i < cells.length; i += step) {
        const c = cells[i];
        if (this.owners[c] === p.id && this.canBuildPort(p.id, c)) {
          this.build(p.id, 'port', c);
          break;
        }
      }
    }

    // Страны: агрессия зависит от сложности
    const aggro = DIFFICULTY[this.difficulty].aggro;
    p.thinkAt = this.tickNo + Math.round(18 / aggro) + ((Math.random() * 30) | 0);
    const readiness = 0.25 / Math.max(1, aggro);
    if (p.troops < p.maxTroops * readiness || p.troops < 150) return;
    if (!counts.size) return;
    let target: number;
    if (counts.has(0) && Math.random() < 0.6) {
      target = 0;
    } else {
      const enemies = [...counts.keys()].filter((k) => k !== 0);
      target = enemies.length ? enemies[(Math.random() * enemies.length) | 0] : 0;
    }
    this.launchAttackOwner(p.id, target, Math.floor(p.troops * 0.5));
  }

  playersPub(): PlayerPub[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      troops: Math.floor(p.troops),
      maxTroops: p.maxTroops,
      cells: p.cells,
      alive: p.alive,
      bot: p.bot,
      strong: p.strong,
      money: Math.floor(p.money),
    }));
  }

  buildingsPub(): BuildingPub[] {
    return this.buildings.map((b) => ({
      id: b.id,
      owner: b.owner,
      cell: b.cell,
      type: b.type,
      progress: Math.max(
        0,
        Math.min(1, 1 - (b.readyTick - this.tickNo) / (b.type === 'port' ? PORT_BUILD_TICKS : HQ_BUILD_TICKS))
      ),
      level: b.level,
      fuse: b.fuseTick > 0 ? Math.max(0, (b.fuseTick - this.tickNo) / 10) : 0,
      upProgress:
        b.upEnd > b.upStart
          ? Math.max(0, Math.min(1, (this.tickNo - b.upStart) / (b.upEnd - b.upStart)))
          : 0,
    }));
  }

  attacksPub(): AttackPub[] {
    return this.attacks
      .filter((a) => a.troops >= 1)
      .map((a) => ({ player: a.player, target: a.target, troops: Math.floor(a.troops) }));
  }

  boatsPub(): BoatPub[] {
    return this.boats.map((b) => ({
      id: b.id,
      player: b.player,
      target: b.target,
      troops: Math.floor(b.troops),
      x: +b.x.toFixed(1),
      y: +b.y.toFixed(1),
      // полный маршрут — клиент считает позицию по той же геометрии, что сервер
      path: b.path,
      // доля пройденного пути по дистанции
      prog: Math.max(0, Math.min(1, b.traveled / b.totalLen)),
    }));
  }
}
