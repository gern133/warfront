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
  CITY_BUILD_TICKS,
  cityCost,
  cityTroopBonus,
  SILO_COST,
  SILO_BUILD_TICKS,
  SILO_RELOAD_TICKS,
  NUKES,
  nukeFlightTicks,
  MissilePub,
  SAM_BUILD_TICKS,
  SAM_RELOAD_TICKS,
  SAM_RANGE,
  samCost,
} from '../../shared/protocol';
import { earthTerrain, canalCoarseCells, fbm, smoothstep, EARTH_W, EARTH_H } from '../map/earthmap';
import { Player, Building, TradeShip, Missile, Attack, Boat } from './types';
import {
  TRADE_SPEED,
  BOAT_SPEED,
  RANDOM_W,
  RANDOM_H,
  LAND_RATIO,
  SPAWN_TROOPS,
  NEUTRAL_COST,
  GROWTH_SLOW_FROM,
  WAVE_SPEED,
  WEAK_COUNT,
  STRONG_COUNT,
  WEAK_GROWTH,
  WEAK_MAX,
  DIFFICULTY,
  STRONG_NAMES,
  weakNames,
  pickShuffled,
  chaikin,
  dpSimplify,
} from './constants';

// Реэкспорт для внешних потребителей (совместимость с прежним API game.ts)
export type { Player } from './types';
export { DIFFICULTY, WEAK_COUNT, STRONG_COUNT } from './constants';

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
  missiles: Missile[] = []; // ракеты в полёте
  private nextMissileId = 1;
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
  // переиспользуемые буферы для пиксельного A*-поиска морского пути (строго по воде)
  private finePrev: Int32Array = new Int32Array(0);
  private fineDisc: Int32Array = new Int32Array(0); // «поколение» открытия клетки
  private fineClosed: Int32Array = new Int32Array(0);
  private fineG: Int32Array = new Int32Array(0); // стоимость пути до клетки
  private heapCell: Int32Array = new Int32Array(0);
  private heapKey: Int32Array = new Int32Array(0);
  private fineGen = 0;
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
    this.missiles = [];
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
    // узкие каналы/проливы грубая сетка не видит (блок не полностью водный) —
    // принудительно открываем судоходный коридор вдоль них
    if (this.mapType === 'earth') {
      for (const c of canalCoarseCells(this.w, this.h, k, this.cw, this.ch)) {
        this.cwater[c] = 1;
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

  // ближайшая клетка настоящей ВОДЫ к точке (px,py) в пределах радиуса. Нужно,
  // чтобы точки маршрута лодки сидели на воде, а не на суше: центр грубого блока
  // в узком проливе часто попадает на сушу, и лодка «резала» бы берег
  private nearestWaterFine(px: number, py: number, maxR: number): [number, number] {
    if (px >= 0 && py >= 0 && px < this.w && py < this.h && !this.terrain[py * this.w + px]) return [px, py];
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          if (!this.terrain[y * this.w + x]) return [x, y];
        }
      }
    }
    return [px, py];
  }

  // ближайшая клетка СУШИ к точке (px,py) в пределах радиуса (−1, если нет)
  private nearestLandCell(px: number, py: number, maxR: number): number {
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          if (this.terrain[y * this.w + x]) return y * this.w + x;
        }
    }
    return -1;
  }

  // клетка воды считается «прибрежной», если рядом (4-соседство) есть суша
  private isCoastalCell(x: number, y: number): boolean {
    const w = this.w, t = this.terrain;
    return (
      (x > 0 && !!t[y * w + x - 1]) ||
      (x < w - 1 && !!t[y * w + x + 1]) ||
      (y > 0 && !!t[(y - 1) * w + x]) ||
      (y < this.h - 1 && !!t[(y + 1) * w + x])
    );
  }

  // Пиксельный A*-поиск морского пути СТРОГО по воде от нашего берега (sx,sy) до
  // воды, примыкающей к материку цели (targetLand), ближайшей к точке клика (cx,cy).
  // Засев — вся вода в диске радиуса R у нашего берега; финиш — вода у берега цели.
  // Путь начинается/кончается вплотную к берегам, держится открытой воды, проходит
  // проливы, по суше НЕ идёт. null — берег цели морем недостижим (напр. Каспий).
  private waterPathFine(sx: number, sy: number, targetLand: number, cx: number, cy: number): number[] | null {
    const w = this.w, h = this.h, N = w * h, ck = this.ck;
    const gx = cx, gy = cy; // эвристика тянет к точке клика
    const R = 3; // радиус диска засева у нашего берега (близко к берегу — старт у суши)
    if (this.finePrev.length !== N) {
      this.finePrev = new Int32Array(N);
      this.fineDisc = new Int32Array(N);
      this.fineClosed = new Int32Array(N);
      this.fineG = new Int32Array(N);
      this.heapCell = new Int32Array(N + 1);
      this.heapKey = new Int32Array(N + 1);
    }
    const gen = ++this.fineGen;
    const prev = this.finePrev, disc = this.fineDisc, closed = this.fineClosed, g = this.fineG;
    const hc = this.heapCell, hk = this.heapKey;
    let hn = 0;
    const cheb = (c: number) => {
      const dx = Math.abs((c % w) - gx), dy = Math.abs(((c / w) | 0) - gy);
      return dx > dy ? dx : dy;
    };
    const siftUp = (i: number) => {
      while (i > 1) {
        const p = i >> 1;
        if (hk[p] <= hk[i]) break;
        const tc = hc[p]; hc[p] = hc[i]; hc[i] = tc;
        const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk;
        i = p;
      }
    };
    const siftDown = (i: number) => {
      for (;;) {
        let m = i;
        const l = i << 1, r = l + 1;
        if (l <= hn && hk[l] < hk[m]) m = l;
        if (r <= hn && hk[r] < hk[m]) m = r;
        if (m === i) break;
        const tc = hc[m]; hc[m] = hc[i]; hc[i] = tc;
        const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
        i = m;
      }
    };
    // единичная стоимость шага + лёгкий штраф за прибрежную клетку. Каждую клетку
    // кладём в кучу лишь раз (без пере-релаксации) — куча не переполняется и поиск
    // быстр; путь получается по воде, у берега — только когда огибает сушу/пролив.
    const COAST = 3;
    const R2 = R * R;
    // засев: вся вода в диске радиуса R у нашего берега
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R2) continue;
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const c = y * w + x;
        if (!this.terrain[c]) { disc[c] = gen; g[c] = 0; prev[c] = -1; hc[++hn] = c; hk[hn] = cheb(c); }
      }
    if (hn === 0) return null;
    // вода примыкает к материку цели? (4-соседство — клетка суши с landId=targetLand)
    const touchesTarget = (x: number, y: number) =>
      (x > 0 && this.terrain[y * w + x - 1] === 1 && this.landId[y * w + x - 1] === targetLand) ||
      (x < w - 1 && this.terrain[y * w + x + 1] === 1 && this.landId[y * w + x + 1] === targetLand) ||
      (y > 0 && this.terrain[(y - 1) * w + x] === 1 && this.landId[(y - 1) * w + x] === targetLand) ||
      (y < h - 1 && this.terrain[(y + 1) * w + x] === 1 && this.landId[(y + 1) * w + x] === targetLand);
    let endCell = -1, bestCell = -1, bestD = Infinity, explored = 0;
    // страховка от «недостижимого» берега: если исследовали слишком много воды и
    // так и не коснулись цели — считаем недостижимым (обычному маршруту хватает тысяч)
    const EXPLORE_CAP = 300_000;
    while (hn > 0) {
      const c = hc[1];
      hc[1] = hc[hn]; hk[1] = hk[hn]; hn--;
      if (hn) siftDown(1);
      if (closed[c] === gen) continue;
      closed[c] = gen;
      if (++explored > EXPLORE_CAP) break;
      const x = c % w, y = (c / w) | 0;
      if (touchesTarget(x, y)) { // вода у берега цели — кандидат на точку высадки
        const ex = x - gx, ey = y - gy, ed = ex * ex + ey * ey;
        if (ed < bestD) { bestD = ed; bestCell = c; }
        if (ed <= R2) { endCell = c; break; } // прямо у точки клика — финиш
      }
      const gc = g[c];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nc = ny * w + nx;
          if (this.terrain[nc] || disc[nc] === gen) continue; // кладём клетку один раз
          // не срезаем угол суши по диагонали
          if (dx && dy && (this.terrain[y * w + nx] || this.terrain[ny * w + x])) continue;
          disc[nc] = gen; g[nc] = gc + 1 + (this.isCoastalCell(nx, ny) ? COAST : 0); prev[nc] = c;
          hc[++hn] = nc; hk[hn] = g[nc] + cheb(nc); siftUp(hn);
        }
    }
    // не дошли вплотную к клику, но касание цели было (фьорд/изрезанный берег) —
    // берём ближайшую к клику воду у берега цели
    if (endCell < 0) endCell = bestCell;
    if (endCell < 0) return null; // берега цели морем не достичь
    const path: number[] = [];
    for (let c = endCell; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    return path;
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
    // явный клик: пересобираем фронт этой атаки, чтобы захват сразу пошёл и по
    // только что появившимся клеткам цели (напр. нейтральный кратер от взрыва),
    // а не ждал, пока опустеет текущий фронт
    const a = this.attacks.find((x) => x.player === playerId && x.target === targetOwner);
    if (a) {
      this.buildFrontier(a);
      a.rescanned = false;
    }
  }

  // Морское вторжение (ПКМ): десант к берегу цели. true = отправлен
  launchInvasion(playerId: number, cell: number, ratio: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    const to = this.owners[cell];
    if (to === playerId) return false;
    if (to > 0 && this.relation(playerId, to) === 'allied') return false;
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return false;
    // потолок 50%: дома всегда остаётся минимум половина армии, чтобы десант
    // (общий ползунок с наземной атакой) не сливал почти всю армию
    const r = Math.min(0.5, Math.max(0.05, ratio || 0));
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
    let landCell = this.landingShore(targetCell, tx, ty);
    const lx = landCell % this.w;
    const ly = (landCell / this.w) | 0;
    // отправная точка — ближайший берег игрока именно к точке высадки
    const src = this.nearestCoast(playerId, lx, ly);
    if (src < 0) return false; // нет выхода к морю
    const sx = src % this.w;
    const sy = (src / this.w) | 0;
    // Маршрут — пиксельный A* строго по воде от нашего берега к воде у берега цели.
    // Лодка НИКОГДА не идёт по суше, держится открытой воды, проходит проливы. null
    // означает «морем не добраться» (напр. бессточный Каспий) — десант отменяется.
    const targetLand = this.landId[landCell];
    const fine = this.waterPathFine(sx, sy, targetLand, lx, ly);
    if (!fine) return false;
    // фактическая клетка высадки — суша цели у конца маршрута (лодка могла прийти
    // не точно в кликнутую точку, если та в отрезанном фьорде)
    const arr = fine[fine.length - 1];
    const near = this.nearestLandCell(arr % this.w, (arr / this.w) | 0, this.ck * 2);
    if (near >= 0) landCell = near;
    // Путь: наш берег → клетки A* (строго вода) → берег высадки. Засев A* рядом с
    // берегом, поэтому переход берег↔вода — всего пара клеток (лодка стартует ОТ
    // берега и причаливает К берегу), а вся середина маршрута идёт по воде.
    const raw: number[] = [sx + 0.5, sy + 0.5];
    for (let i = 0; i < fine.length; i++) {
      const c = fine[i];
      raw.push((c % this.w) + 0.5, ((c / this.w) | 0) + 0.5);
    }
    raw.push((landCell % this.w) + 0.5, ((landCell / this.w) | 0) + 0.5);
    // сглаживаем плотный водный путь (держится воды), затем прорежаем по Дугласу–
    // Пекеру — компактно и в пределах ~пикселя от воды, без «вылезаний» на сушу
    const path = dpSimplify(chaikin(raw), 0.8);
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
      x: sx + 0.5, // старт лодки — от нашего берега
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
    // остаток десанта наступает вглубь берега. Войска берём ИЗ ЛОДКИ (они уже
    // сняты с домашней армии при отправке) — иначе списывалось бы дважды
    if (target <= 0 || this.relation(b.player, target) !== 'allied') {
      this.pushAttack(b.player, target, Math.floor(b.troops * 0.6));
    }
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

  // суммарный уровень всех городов игрока — от него растёт цена следующей покупки
  private cityLevels(playerId: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === playerId && b.type === 'city') n += b.level;
    return n;
  }

  // суммарный уровень всех ПВО игрока — от него растёт цена следующей покупки
  private samLevels(playerId: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === playerId && b.type === 'sam') n += b.level;
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

  // ближайшее своё здание данного типа в радиусе PORT_RADIUS (для апгрейда вместо новой)
  private nearbyOwnType(playerId: number, cell: number, type: BuildingType): Building | undefined {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const r2 = PORT_RADIUS * PORT_RADIUS;
    return this.buildings.find(
      (b) =>
        b.type === type &&
        b.owner === playerId &&
        (b.cell % this.w - cx) ** 2 + ((b.cell / this.w | 0) - cy) ** 2 <= r2
    );
  }

  // есть ли рядом (радиус r) чужое/своё здание указанных типов — для запрета
  // ставить порты и города впритык друг к другу
  private buildingNear(cell: number, r: number, types: BuildingType[]): boolean {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const r2 = r * r;
    return this.buildings.some(
      (b) =>
        types.includes(b.type) &&
        (b.cell % this.w - cx) ** 2 + ((b.cell / this.w | 0) - cy) ** 2 <= r2
    );
  }

  // Постройка здания. Возвращает код ошибки или null при успехе.
  build(playerId: number, bt: BuildingType, cell: number): string | null {
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return 'Нельзя строить';
    if (bt === 'port') {
      // клик рядом со своим портом — апгрейд, а не новый порт
      const near = this.nearbyOwnType(playerId, cell, 'port');
      if (near) return this.upgrade(playerId, near.cell);
      // притягиваем к ближайшему своему берегу (клик в радиусе PORT_RADIUS от него)
      const shore = this.canBuildPort(playerId, cell)
        ? cell
        : this.nearestOwnCoast(playerId, cell, PORT_RADIUS);
      if (shore < 0) return 'Рядом нет своего берега';
      // порт нельзя ставить впритык к любому другому строению
      if (this.buildingNear(shore, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam']))
        return 'Слишком близко к другому зданию';
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
        stock: 0,
        reloadTick: 0,
        reloads: [],
      });
      return null;
    }
    if (bt === 'city') {
      // клик рядом со своим городом — апгрейд, а не новый город
      const near = this.nearbyOwnType(playerId, cell, 'city');
      if (near) return this.upgrade(playerId, near.cell);
      if (!this.canBuildAt(playerId, cell)) return 'Стройте в глубине своей земли';
      // города нельзя ставить впритык к любому другому строению
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam']))
        return 'Слишком близко к другому зданию';
      const cost = cityCost(this.cityLevels(playerId));
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      this.buildings.push({
        id: this.nextBuildingId++,
        owner: playerId,
        cell,
        type: 'city',
        readyTick: this.tickNo + CITY_BUILD_TICKS,
        level: 1,
        fuseTick: 0,
        upStart: 0,
        upEnd: 0,
        nextShipTick: 0,
        ships: 0,
        stock: 0,
        reloadTick: 0,
        reloads: [],
      });
      return null;
    }
    if (bt === 'silo') {
      // клик рядом со своей шахтой — апгрейд
      const near = this.nearbyOwnType(playerId, cell, 'silo');
      if (near) return this.upgrade(playerId, near.cell);
      if (!this.canBuildAt(playerId, cell)) return 'Стройте в глубине своей земли';
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam']))
        return 'Слишком близко к другому зданию';
      if (p.money < SILO_COST) return 'Недостаточно денег';
      p.money -= SILO_COST;
      this.buildings.push({
        id: this.nextBuildingId++,
        owner: playerId,
        cell,
        type: 'silo',
        readyTick: this.tickNo + SILO_BUILD_TICKS,
        level: 1,
        fuseTick: 0,
        upStart: 0,
        upEnd: 0,
        nextShipTick: 0,
        ships: 0,
        stock: 1, // одна ракета готова к пуску после постройки
        reloadTick: 0,
        reloads: [],
      });
      return null;
    }
    if (bt === 'sam') {
      // клик рядом со своим ПВО — апгрейд
      const near = this.nearbyOwnType(playerId, cell, 'sam');
      if (near) return this.upgrade(playerId, near.cell);
      if (!this.canBuildAt(playerId, cell)) return 'Стройте в глубине своей земли';
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam']))
        return 'Слишком близко к другому зданию';
      const cost = samCost(this.samLevels(playerId));
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      this.buildings.push({
        id: this.nextBuildingId++,
        owner: playerId,
        cell,
        type: 'sam',
        readyTick: this.tickNo + SAM_BUILD_TICKS,
        level: 1,
        fuseTick: 0,
        upStart: 0,
        upEnd: 0,
        nextShipTick: 0,
        ships: 0,
        stock: 0,
        reloadTick: 0,
        reloads: [],
      });
      return null;
    }
    if (!this.canBuildAt(playerId, cell)) return 'Здесь строить нельзя';
    // штаб нельзя ставить впритык к другому штабу/порту/городу/шахте
    if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam']))
      return 'Слишком близко к другому зданию';
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
      stock: 0,
      reloadTick: 0,
      reloads: [],
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
    if (b.type === 'city') {
      const cost = cityCost(this.cityLevels(playerId)); // по текущей сумме уровней
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      b.level++; // город апгрейдится мгновенно, уровней сколько угодно
      return null;
    }
    if (b.upEnd > 0) return 'Уже улучшается';
    if (b.type === 'silo') {
      // шахта: апгрейд по 1млн, идёт 5с; уровень = размер залпа
      if (p.money < SILO_COST) return 'Недостаточно денег';
      p.money -= SILO_COST;
      b.upStart = this.tickNo;
      b.upEnd = this.tickNo + SILO_BUILD_TICKS;
      return null;
    }
    if (b.type === 'sam') {
      // ПВО: апгрейд «в общем» по сумме уровней, идёт 5с; уровень = число перехватов
      const cost = samCost(this.samLevels(playerId));
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      b.upStart = this.tickNo;
      b.upEnd = this.tickNo + SAM_BUILD_TICKS;
      return null;
    }
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

  // --- Ракетные шахты и ядерные удары ---
  // Перезарядка залпа: +1 ракета раз в SILO_RELOAD_TICKS до потолка (= уровень)
  private reloadSilos() {
    for (const b of this.buildings) {
      if (b.type === 'silo' && this.tickNo >= b.readyTick && b.stock < b.level) {
        if (this.tickNo >= b.reloadTick) {
          b.stock++;
          b.reloadTick = this.tickNo + SILO_RELOAD_TICKS;
        }
      } else if (b.type === 'sam' && b.reloads.length) {
        // ПВО: израсходованные заряды восстанавливаются параллельно (каждый 7с)
        if (b.reloads.some((t) => this.tickNo >= t)) {
          b.reloads = b.reloads.filter((t) => this.tickNo < t);
        }
      }
    }
  }

  // Перехват летящей ядерки ближайшим подходящим ПВО (не своего владельца, цель
  // в радиусе, есть свободный заряд). Проверяется КАЖДЫЙ тик, пока ракета не
  // перехвачена и не подлетела вплотную — так ПВО сбивает и те ракеты, что были
  // выпущены во время его перезарядки (перехватит, как только перезарядится).
  private tryIntercept(m: Missile) {
    if (m.killProg > 0 || m.prog >= 0.88) return; // уже перехвачена или поздно
    const cx = m.tx;
    const cy = m.ty;
    const r2 = SAM_RANGE * SAM_RANGE;
    let sam: Building | undefined;
    let bestD = Infinity;
    for (const b of this.buildings) {
      if (b.type !== 'sam' || b.owner === m.owner) continue;
      if (this.tickNo < b.readyTick) continue;
      if (b.reloads.length >= b.level) continue; // все заряды на перезарядке
      const bx = b.cell % this.w;
      const by = (b.cell / this.w) | 0;
      const d = (bx + 0.5 - cx) ** 2 + (by + 0.5 - cy) ** 2;
      if (d <= r2 && d < bestD) {
        bestD = d;
        sam = b;
      }
    }
    if (!sam) return;
    sam.reloads.push(this.tickNo + SAM_RELOAD_TICKS); // заряд израсходован
    // точка перехвата впереди по курсу ракеты (с запасом на подлёт перехватчика)
    m.killProg = Math.min(0.9, m.prog + 0.5);
    // точка встречи — где ракета будет В ВОЗДУХЕ на своей баллистической дуге
    // (та же формула дуги, что в рендере: arc = min(dist*0.4, 140))
    const kx = m.sx + (m.tx - m.sx) * m.killProg;
    const ky = m.sy + (m.ty - m.sy) * m.killProg;
    const gdist = Math.hypot(m.tx - m.sx, m.ty - m.sy);
    const lift = Math.min(gdist * 0.4, 140) * Math.sin(Math.PI * m.killProg);
    this.missiles.push({
      id: this.nextMissileId++,
      owner: sam.owner,
      kind: 'interceptor',
      sx: (sam.cell % this.w) + 0.5,
      sy: ((sam.cell / this.w) | 0) + 0.5,
      tx: kx,
      ty: ky - lift, // целимся выше — в точку ракеты на дуге, а не в землю
      targetCell: 0,
      prog: 0,
      // прилетает в точку перехвата ровно тогда, когда ракета туда доходит
      flightTicks: Math.max(1, Math.round((m.killProg - m.prog) * m.flightTicks)),
      done: false,
      intercept: true,
      killProg: 0,
    });
  }

  // Пуск ракеты из ближайшей заряженной шахты игрока в клетку cell.
  launchNuke(playerId: number, cell: number, kind = 'basic'): string | null {
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return 'Нельзя';
    if (cell < 0 || cell >= this.cells) return 'Неверная цель';
    const spec = NUKES[kind];
    if (!spec) return 'Неизвестная ракета';
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    // ближайшая своя достроенная шахта с зарядом
    let silo: Building | undefined;
    let bestD = Infinity;
    for (const b of this.buildings) {
      if (b.type !== 'silo' || b.owner !== playerId) continue;
      if (this.tickNo < b.readyTick || b.stock <= 0) continue;
      const d = (b.cell % this.w - cx) ** 2 + ((b.cell / this.w | 0) - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        silo = b;
      }
    }
    if (!silo) return 'Нет заряженной шахты';
    if (p.money < spec.cost) return 'Недостаточно денег';
    p.money -= spec.cost;
    silo.stock--;
    // если шахта была полной — запускаем таймер перезарядки
    if (silo.reloadTick <= this.tickNo) silo.reloadTick = this.tickNo + SILO_RELOAD_TICKS;
    const sx = (silo.cell % this.w) + 0.5;
    const sy = ((silo.cell / this.w) | 0) + 0.5;
    const dist = Math.hypot(cx + 0.5 - sx, cy + 0.5 - sy);
    const nuke: Missile = {
      id: this.nextMissileId++,
      owner: playerId,
      kind,
      sx,
      sy,
      tx: cx + 0.5,
      ty: cy + 0.5,
      targetCell: cell,
      prog: 0,
      flightTicks: nukeFlightTicks(spec, dist), // время полёта — по расстоянию
      done: false,
      intercept: false,
      killProg: 0,
    };
    this.missiles.push(nuke);
    return null;
  }

  private stepMissiles() {
    if (!this.missiles.length) return;
    // сперва пробуем перехватить все ещё-не-сбитые ядерки (ПВО могло только что
    // перезарядиться — тогда собьёт ракету, выпущенную во время перезарядки).
    // Идём по исходной длине — tryIntercept добавляет перехватчики в конец.
    const n = this.missiles.length;
    for (let i = 0; i < n; i++) {
      const m = this.missiles[i];
      if (!m.intercept && m.killProg === 0) this.tryIntercept(m);
    }
    for (const m of this.missiles) {
      m.prog += 1 / Math.max(1, m.flightTicks);
      if (m.intercept) {
        if (m.prog >= 1) m.done = true; // перехватчик долетел и исчез
      } else if (m.killProg > 0 && m.prog >= m.killProg) {
        m.done = true; // сбита ПВО — без взрыва
      } else if (m.prog >= 1) {
        m.done = true;
        const spec = NUKES[m.kind];
        this.detonate(m.targetCell, spec?.radius ?? HQ_EXPLODE_RADIUS * 2, spec?.armyFrac ?? 0.25);
      }
    }
    if (this.missiles.some((m) => m.done)) {
      this.missiles = this.missiles.filter((m) => !m.done);
    }
  }

  missilesPub(): MissilePub[] {
    return this.missiles.map((m) => ({
      id: m.id,
      owner: m.owner,
      kind: m.kind,
      sx: m.sx,
      sy: m.sy,
      tx: m.tx,
      ty: m.ty,
      prog: Math.min(1, m.prog),
      intercept: m.intercept,
    }));
  }

  // Захват/фитиль/взрыв щитов. Вызывается каждый тик (зданий немного).
  private checkBuildings() {
    const remove = new Set<Building>();
    const explosions: { cell: number; level: number }[] = [];
    for (const b of this.buildings) {
      if (this.tickNo < b.readyTick) continue; // ещё строится — неуязвим
      // порт/город/шахта/ПВО: при захвате клетки переходят захватчику (нейтраль/взрыв — снос)
      if (b.type === 'port' || b.type === 'city' || b.type === 'silo' || b.type === 'sam') {
        const now = this.owners[b.cell];
        if (now !== b.owner) {
          if (now > 0 && this.players.get(now)?.alive) {
            b.owner = now; // новый хозяин
            b.nextShipTick = this.tickNo + PORT_SHIP_INTERVAL;
            b.stock = 0; // шахта достаётся разряженной
            b.reloadTick = this.tickNo + SILO_RELOAD_TICKS;
            b.reloads = []; // ПВО достаётся с полными зарядами
            b.upStart = 0;
            b.upEnd = 0;
          } else {
            remove.add(b);
          }
        } else if ((b.type === 'silo' || b.type === 'sam') && b.upEnd > 0 && this.tickNo >= b.upEnd) {
          b.level++; // апгрейд завершён (силос — залп, ПВО — число перехватов)
          b.upStart = 0;
          b.upEnd = 0;
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

  // Взрыв прокачанного щита: 3 ур. — двойной радиус и 25% армии; иначе базовый
  // радиус и урон по армии пропорционально доле уничтоженной территории
  private explode(cell: number, level: number) {
    const R = level >= 3 ? HQ_EXPLODE_RADIUS * 2 : HQ_EXPLODE_RADIUS;
    this.detonate(cell, R, level >= 3 ? 0.25 : -1);
  }

  // Общий взрыв по области: обнуляет территорию в радиусе R и бьёт по армии
  // каждого задетого игрока. armyFrac >= 0 — фиксированная доля армии; < 0 —
  // пропорционально доле потерянной территории. Параметры варьируются по типу
  // оружия (щит/ядерка/будущие ракеты).
  private detonate(cell: number, R: number, armyFrac: number) {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
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
    for (const [owner, n] of lost) {
      const p = this.players.get(owner);
      if (p && p.cells > 0) {
        const frac = armyFrac >= 0 ? armyFrac : n / p.cells;
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
      if (this.tickNo < b.readyTick || b.type !== 'hq') continue; // укрепляет только штаб
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
    p.troops -= troops; // войска берутся из домашней армии
    this.pushAttack(playerId, targetOwner, troops);
  }

  // добавить/усилить атаку БЕЗ списания из домашней армии — для десанта, чьи
  // войска уже сняты в лодку при отправке (иначе двойное списание)
  private pushAttack(playerId: number, targetOwner: number, troops: number) {
    if (troops < 10) return;
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
    // суммарная прибавка к лимиту войск от достроенных городов (по игрокам)
    const cityBonus = new Map<number, number>();
    for (const b of this.buildings) {
      if (b.type !== 'city' || this.tickNo < b.readyTick) continue;
      cityBonus.set(b.owner, (cityBonus.get(b.owner) || 0) + cityTroopBonus(b.level));
    }
    for (const p of this.players.values()) {
      if (!p.alive || !p.spawned) continue;
      // ранний фактор: 1 на старте → 0 через 45с
      const early = Math.max(0, 1 - (this.tickNo - p.spawnTick) / 450);
      // в начале даём запас потолка, чтобы армия росла сразу (а не только
      // территория); к 45с запас исчезает, но реальный потолок уже больше
      p.maxTroops = (150 + p.cells * 12) * p.maxMul + early * 1500 + (cityBonus.get(p.id) || 0);
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
        if (this.hasNeutralBorder(p.id)) {
          if (early > 0) {
            // ранняя игра: агрессивно осваиваем нейтраль (быстрый старт)
            if (p.troops > p.maxTroops * 0.5) {
              this.launchAttackOwner(p.id, 0, Math.floor(p.troops * 0.15));
            }
          } else if (p.troops > p.maxTroops * 0.75) {
            // поздняя игра: тратим только излишек над 75% лимита и мягко —
            // огромная армия НЕ сливается в ноль (в т.ч. отвоёвывая кратеры)
            this.launchAttackOwner(p.id, 0, Math.floor((p.troops - p.maxTroops * 0.75) * 0.3));
          }
        }
      }
    }
    this.cancelOpposing();
    this.stepBoats();
    this.spawnTradeShips();
    this.stepTradeShips();
    this.reloadSilos();
    this.stepMissiles();
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
    let enemyFrom = -1; // своя клетка на границе с врагом
    let enemyTo = -1; // соседняя вражеская клетка (для наведения ядерки)
    for (let i = (Math.random() * step) | 0; i < cells.length; i += step) {
      const c = cells[i];
      if (this.owners[c] !== p.id) continue; // протухшая запись
      this.forNeighbors(c, (n) => {
        if (this.terrain[n] && this.owners[n] !== p.id) {
          const o = this.owners[n];
          counts.set(o, (counts.get(o) || 0) + 1);
          if (o > 0) {
            enemyFrom = c;
            enemyTo = n;
          }
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

    // Страны строят города (рост лимита войск) и штабы-щиты (оборона) — как игрок.
    // Ограничиваем число, чтобы не спамить, и гейтим деньгами.
    if (p.strong) {
      const myCities = this.buildings.filter((b) => b.owner === p.id && b.type === 'city').length;
      if (myCities < 3 && p.money >= cityCost(this.cityLevels(p.id))) {
        for (let i = 0; i < cells.length; i += step) {
          const c = cells[i];
          if (this.canBuildAt(p.id, c) && !this.buildingNear(c, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam'])) {
            this.build(p.id, 'city', c);
            break;
          }
        }
      }
      const myHqs = this.hqCount(p.id);
      if (myHqs < 2 && p.money >= hqCost(myHqs)) {
        for (let i = 0; i < cells.length; i += step) {
          const c = cells[i];
          if (this.canBuildAt(p.id, c) && !this.buildingNear(c, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam'])) {
            this.build(p.id, 'hq', c);
            break;
          }
        }
      }
      // ракетная шахта (дорогая — одна на страну, если разбогатела)
      const mySilos = this.buildings.filter((b) => b.owner === p.id && b.type === 'silo').length;
      if (mySilos < 1 && p.money >= SILO_COST) {
        for (let i = 0; i < cells.length; i += step) {
          const c = cells[i];
          if (this.canBuildAt(p.id, c) && !this.buildingNear(c, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam'])) {
            this.build(p.id, 'silo', c);
            break;
          }
        }
      }
      // ПВО (дорогое — одно на страну, если совсем разбогатела)
      const mySams = this.buildings.filter((b) => b.owner === p.id && b.type === 'sam').length;
      if (mySams < 1 && p.money >= samCost(0)) {
        for (let i = 0; i < cells.length; i += step) {
          const c = cells[i];
          if (this.canBuildAt(p.id, c) && !this.buildingNear(c, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam'])) {
            this.build(p.id, 'sam', c);
            break;
          }
        }
      }
      // пуск ракеты по врагу: если есть заряженная шахта, деньги и цель рядом.
      // редко (гейт), цель — вглубь врага, чтобы не накрыть себя. Если богат —
      // иногда бьёт водородной (мощнее и дальнобойнее)
      if (
        enemyTo >= 0 &&
        Math.random() < 0.15 &&
        p.money >= NUKES.basic.cost &&
        this.buildings.some((b) => b.owner === p.id && b.type === 'silo' && this.tickNo >= b.readyTick && b.stock > 0)
      ) {
        const kind = p.money >= NUKES.hydro.cost && Math.random() < 0.35 ? 'hydro' : 'basic';
        const R = NUKES[kind].radius;
        const fx = enemyFrom % this.w;
        const fy = (enemyFrom / this.w) | 0;
        const ex = enemyTo % this.w;
        const ey = (enemyTo / this.w) | 0;
        const dx = ex - fx;
        const dy = ey - fy;
        const len = Math.hypot(dx, dy) || 1;
        // сдвигаем цель на ~радиус вглубь территории врага
        const tx = Math.max(0, Math.min(this.w - 1, Math.round(ex + (dx / len) * R)));
        const ty = Math.max(0, Math.min(this.h - 1, Math.round(ey + (dy / len) * R)));
        this.launchNuke(p.id, ty * this.w + tx, kind);
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
      ammo:
        b.type === 'silo'
          ? b.stock
          : b.type === 'sam'
            ? Math.max(0, b.level - b.reloads.length)
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
