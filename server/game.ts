import { PlayerPub, AttackPub, BoatPub, Difficulty, MapType } from '../shared/protocol';
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
  thinkAt: number;
}

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
      thinkAt: this.tickNo + 20 + ((Math.random() * 30) | 0),
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
    this.claimDisk(cell % this.w, (cell / this.w) | 0, p.id, true);
    p.spawned = true;
    p.troops = SPAWN_TROOPS;
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
      return;
    }
  }

  private claimDisk(cx: number, cy: number, id: number, takeBots = false) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy > 9) continue;
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
    this.cellsOf.delete(id);
    this.players.delete(id);
  }

  private setOwner(c: number, owner: number) {
    const prev = this.owners[c];
    if (prev === owner) return;
    if (prev > 0) {
      const p = this.players.get(prev);
      if (p) {
        p.cells--;
        if (p.cells <= 0 && p.alive && p.spawned) this.kill(p);
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

  private kill(p: Player) {
    p.alive = false;
    p.troops = 0;
    this.deaths.push(p.id);
    this.attacks = this.attacks.filter((a) => a.player !== p.id);
    this.boats = this.boats.filter((b) => b.player !== p.id);
  }

  // Сухопутная атака (ЛКМ): наступление по суше от общей границы
  launchAttackCell(playerId: number, cell: number, ratio: number) {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return;
    const targetOwner = this.owners[cell];
    if (targetOwner === playerId) return;
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return;
    const r = Math.min(1, Math.max(0.05, ratio || 0));
    this.launchAttackOwner(playerId, targetOwner, Math.floor(p.troops * r));
  }

  // Морское вторжение (ПКМ): десант к берегу цели. true = отправлен
  launchInvasion(playerId: number, cell: number, ratio: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    if (this.owners[cell] === playerId) return false;
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

  launchAttackOwner(playerId: number, targetOwner: number, troops: number) {
    const p = this.players.get(playerId);
    if (!p?.alive) return;
    troops = Math.min(troops, Math.floor(p.troops));
    if (troops < 10) return;
    p.troops -= troops;
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
    for (const p of this.players.values()) {
      if (!p.alive || !p.spawned) continue;
      p.maxTroops = (150 + p.cells * 12) * p.maxMul;
      // базовый прирост как в рабочем балансе (пропорционален армии)
      const base = Math.max(0.5, p.troops * 0.006 * p.growthMul);
      // логистическое торможение: до 70% максимума — полный рост, дальше плавно
      // затухает почти до нуля у потолка
      const frac = p.maxTroops > 0 ? p.troops / p.maxTroops : 1;
      const taper =
        frac <= GROWTH_SLOW_FROM
          ? 1
          : Math.max(0.03, 1 - ((frac - GROWTH_SLOW_FROM) / (1 - GROWTH_SLOW_FROM)) * 0.97);
      // при малой армии набираем быстрее: <10% лимита — ×2, 10–30% — ×1.5
      const boost = frac < 0.1 ? 2 : frac < 0.3 ? 1.5 : 1;
      p.troops = Math.min(p.maxTroops, p.troops + base * taper * boost);
      if (p.bot) {
        if (this.tickNo >= p.thinkAt) this.botThink(p);
      } else if (this.tickNo >= p.thinkAt) {
        // человек: автоматически расширяется в свободную нейтраль за счёт
        // излишка войск — территория и потолок растут сами, без кликов
        p.thinkAt = this.tickNo + 15;
        if (p.troops > p.maxTroops * 0.55 && this.hasNeutralBorder(p.id)) {
          this.launchAttackOwner(p.id, 0, Math.floor(p.troops * 0.15));
        }
      }
    }
    this.cancelOpposing();
    this.stepBoats();
    for (const a of this.attacks) this.stepAttack(a);
    this.attacks = this.attacks.filter(
      (a) => a.troops >= 1 && this.players.get(a.player)?.alive
    );
    if (this.winnerId === null) {
      for (const p of this.players.values()) {
        if (p.alive && p.cells > this.landCount * 0.65) {
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
    // нападающих. Захват вражеской клетки стоит атакующему (1 + 2·плотность)
    // войск, защитник теряет плотность (свой гарнизон). Скорость наступления
    // пропорциональна перевесу атакующих над обороной.
    let cost = NEUTRAL_COST;
    let enemyLoss = 0;
    let waveScale = 1;
    if (enemy) {
      const density = enemy.cells > 0 ? enemy.troops / enemy.cells : 0;
      cost = 1 + 2 * density;
      enemyLoss = density;
      if (enemy.troops > 0) {
        waveScale = Math.min(6, Math.max(0.2, a.troops / enemy.troops));
      }
    }
    // остаток меньше цены одной клетки — наступление выдохлось, вернуть войска
    if (a.troops < cost) {
      this.refund(a, attacker);
      return;
    }
    let quota = Math.max(1, Math.ceil(a.frontier.size * WAVE_SPEED * waveScale));
    for (let own = 4; own >= 1 && quota > 0; own--) {
      const list = buckets[own];
      while (list.length && quota > 0 && a.troops >= cost) {
        const i = (Math.random() * list.length) | 0;
        const c = list[i];
        list[i] = list[list.length - 1];
        list.pop();
        a.frontier.delete(c);
        this.setOwner(c, a.player);
        a.troops -= cost;
        if (enemy) enemy.troops = Math.max(0, enemy.troops - enemyLoss);
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
