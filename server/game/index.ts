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
  UPGRADE_QUEUE_MAX,
  hqUpgradeCost,
  hqUpgradeTicks,
  TradeShipPub,
  TruckPub,
  WarshipPub,
  TradeEarn,
  PORT_BUILD_COST,
  portCost,
  PORT_BUILD_TICKS,
  PORT_SHIP_INTERVAL,
  PORT_RADIUS,
  PORT_MAX_SHIP_LEVEL,
  portUpgradeCost,
  tradeValue,
  shipsForLevel,
  CITY_BUILD_TICKS,
  cityCost,
  cityUpgradeCost,
  cityTroopBonus,
  FACTORY_BUILD_TICKS,
  FACTORY_RANGE,
  factoryCost,
  factoryBoostPct,
  factoryIncome,
  FACTORY_COVER,
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
  DRONE_COST,
  DRONE_COUNT,
  DRONE_CELLS_PER,
  DRONE_COUNT_MAX,
  TERRAIN_DEF,
  TERRAIN_SPEED,
  TERRAIN_DEF_MIN,
  TERRAIN_TIER,
  TERRAIN_TIERS,
} from '../../shared/protocol';
import { earthTerrain, canalCoarseCells, fbm, smoothstep, EARTH_W, EARTH_H } from '../map/earthmap';
import { buildWaterFields, buildCoarseWater, losWater, smoothWaterPath } from '../../shared/map/water';
import { Player, Building, TradeShip, Missile, Attack, Boat, Warship, Bullet, Truck, Drone } from './types';
import {
  TRADE_SPEED,
  BOAT_SPEED,
  MAX_BOATS,
  TRUCK_SPEED,
  TRUCK_REWARD,
  TRUCK_INTERVAL,
  WARSHIP_SPEED,
  WARSHIP_HP,
  WARSHIP_RANGE,
  WARSHIP_COOLDOWN,
  WARSHIP_DAMAGE,
  WARSHIP_PATROL_R,
  WARSHIP_PATROL_SPD,
  DRONE_SPEED,
  DRONE_FIRE_COOLDOWN,
  DRONE_DAMAGE_FRAC,
  DRONE_BOMBS,
  DRONE_CLEAR_R,
  BULLET_SPEED,
  WARSHIP_REPAIR_AT,
  REPAIR_TICKS_PER_HIT,
  warshipCost,
  RANDOM_W,
  RANDOM_H,
  LAND_RATIO,
  SPAWN_TROOPS,
  NEUTRAL_COST,
  GROWTH_SLOW_FROM,
  WAVE_SPEED,
  DEFEND_BOOST,
  DEFEND_BOOST_TICKS,
  ATTACK_NOTICE_GAP,
  ROUTE_BUDGET,
  LANDING_CLICK_W,
  LANDING_SEARCH_SLACK,
  BOT_TRIGGER,
  BOT_RESERVE,
  BOT_GUARD,
  BOT_MIN_ODDS,
  BOT_RETALIATE_TICKS,
  BOT_RATIO_PORT,
  BOT_RATIO_FACTORY,
  BOT_RATIO_SAM,
  BOT_RATIO_SILO,
  BOT_RATIO_HQ,
  BOT_MAX_SILO,
  BOT_MAX_SAM_LEVEL,
  BOT_UPGRADE_DENSITY,
  BOT_CHEST_BASE,
  BOT_CHEST_WAR,
  BOT_DRONE_CHANCE_WAR,
  BOT_DRONE_CHANCE_IDLE,
  BOT_DRONE_WAVES,
  BOT_ECON_SHARE,
  BOT_MAX_SILO_LEVEL,
  BOT_MAX_FACTORY_LEVEL,
  BOT_QUEUE_BATCH,
  cellFactor,
  COMMITTED_COUNTS,
  DEF_FLOOR,
  RATIO_COST_MIN,
  RATIO_COST_MAX,
  WAVE_SCALE_MAX,
  FORT_SLOW,
  WEAK_COUNT,
  STRONG_COUNT,
  WEAK_GROWTH,
  WEAK_MAX,
  DIFFICULTY,
  STRONG_NAMES,
  weakNames,
  pickShuffled,
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
  warships: Warship[] = []; // боевые корабли
  private nextWarshipId = 1;
  drones: Drone[] = []; // дроны роя «Мопед» в полёте
  private nextDroneId = 1;
  droneBlasts: number[] = []; // взрывы дронов за тик [x,y,...] (для вспышек; чистится в index)
  trucks: Truck[] = []; // грузовики заводов на дорогах
  private nextTruckId = 1;
  // дорожная сеть по владельцам (кэш): узлы — заводы/города/порты, рёбра — пути по
  // суше между инфраструктурой в радиусе завода. Пересчёт при изменении зданий.
  private roadVer = 0;
  private roadSig = 0; // подпись набора дорожной инфраструктуры (для инвалидации кэша)
  private roadNet = new Map<number, { ver: number; adj: Map<number, number[]>; edge: Map<number, number[]>; revenue: Set<number> }>();
  // персистентные дороги игрока (ключ ребра → путь): переживают пересчёт, чтобы
  // существующие маршруты не переприкладывались при постройке нового здания
  private roadEdges = new Map<number, Map<number, number[]>>();
  private roadsCache: { ver: number; data: number[][] } | null = null;
  bullets: Bullet[] = []; // пули кораблей в полёте
  private nextBulletId = 1;
  missiles: Missile[] = []; // ракеты в полёте
  private nextMissileId = 1;
  tradeEarnings: TradeEarn[] = []; // заработок портов за интервал (чистится в index)
  // связи (симметричные): союзники и враги. Храним только пары с участием
  // человека — бот-vs-бот всегда нейтральны. relChanged — кому переслать обновление.
  allies = new Map<number, Set<number>>();
  hostiles = new Map<number, Set<number>>();
  relChanged = new Set<number>();
  // события для ленты: расторжение союза / уничтожение торгового корабля —
  // кому, от кого и (для trade) куда фокусировать камеру; чистится в index
  relNotices: { to: number; kind: 'break' | 'trade' | 'attacked'; name: string; x?: number; y?: number }[] = [];
  // кэш морских маршрутов между клетками портов (порты статичны)
  private routeCache = new Map<number, { path: number[]; cum: number[]; totalLen: number } | null>();
  // поле укреплений: id владельца штаба, покрывающего клетку (0 = нет).
  // пересобирается только при изменении зданий — в бою это O(1) чтение
  fortField: Int16Array;
  private fortLevel: Uint8Array; // уровень укрепляющего штаба на клетку (0 нет)
  private fortDirty = true;
  landId: Int16Array; // id связного материка для каждой клетки суши (-1 = вода)
  difficulty: Difficulty = 'normal';
  infMoney = false; // настройка лобби: у людей всегда 10млрд денег
  infArmy = false; // настройка лобби: у людей армия сразу 100млн (мгновенно)
  // Водная модель карты (см. server/map/water.ts): океан ≠ вода, компоненты
  // связности воды, берег. Пересобирается только при генерации карты.
  ocean: Uint8Array = new Uint8Array(0); // 1 = вода, связанная с краем карты
  lake: Uint8Array = new Uint8Array(0); // 1 = вода, НЕ связанная с океаном
  private coastal: Uint8Array = new Uint8Array(0); // 1 = вода у берега
  shore: Uint8Array = new Uint8Array(0); // 1 = суша, примыкающая к океану
  private waterId: Int32Array = new Int32Array(0); // компонента воды (-1 = суша)
  // грубая водная сетка для поиска морских путей (обход островов). Блок проходим,
  // если в нём есть ХОТЯ БЫ одна водная клетка («вода побеждает», как minimap в
  // OpenFront) — узкие проливы и будущие реки не теряются. Поэтому грубый путь —
  // только коридор-подсказка, он уточняется точным поиском (waterPathCorridor).
  private cw = 0;
  private ch = 0;
  private ck = 1; // коэффициент огрубления
  private cwater: Uint8Array = new Uint8Array(0); // 1 = проходимая вода
  // переиспользуемые буферы грубого BFS и маски коридора
  private coarsePrev: Int32Array = new Int32Array(0);
  private coarseSeen: Int32Array = new Int32Array(0); // «поколение» посещения блока
  private coarseGen = 0;
  private coarseG: Int32Array = new Int32Array(0); // стоимость пути до блока
  private coarseHeapCell: Int32Array = new Int32Array(0);
  private coarseHeapKey: Int32Array = new Int32Array(0);
  private corrStamp: Int32Array = new Int32Array(0);
  private corrGen = 0;
  // сколько новых морских маршрутов ещё можно построить в этом тике
  private routeBudget = ROUTE_BUDGET;
  // переиспользуемые буферы для пиксельного A*-поиска морского пути (строго по воде)
  private finePrev: Int32Array = new Int32Array(0);
  private fineDisc: Int32Array = new Int32Array(0); // «поколение» открытия клетки
  private fineClosed: Int32Array = new Int32Array(0);
  private fineG: Int32Array = new Int32Array(0); // стоимость пути до клетки
  // ДЛИНА пути в шагах (без штрафа за прибрежность): по ней сравниваются варианты
  // высадки, иначе штраф ×3 искажает выбор в пользу берега рядом с нашим
  private fineSteps: Int32Array = new Int32Array(0);
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
    this.warships = [];
    this.drones = [];
    this.droneBlasts = [];
    this.trucks = [];
    this.roadNet.clear();
    this.roadEdges.clear();
    this.roadsCache = null;
    this.roadVer++;
    this.bullets = [];
    this.missiles = [];
    this.tradeEarnings = [];
    this.relNotices = [];
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

  // Водные поля карты + грубая сетка для поиска морских путей.
  //
  // Раньше блок 5×5 считался водой только если в нём НОЛЬ суши: узкие проливы и
  // реки исчезали с сетки, и приходилось вручную прорубать коридоры (CANALS), а
  // сглаженный маршрут всё равно резал сушу. Теперь, как minimap в OpenFront,
  // огрубление вдвое (k=2) и «вода побеждает» — блок проходим, если в нём есть
  // хоть одна водная клетка. Узкая вода сохраняется, а оптимистичность правила
  // компенсируется уточнением пути точным поиском (см. waterRoute).
  private buildWaterGrid() {
    const f = buildWaterFields(this.terrain, this.w, this.h);
    this.ocean = f.ocean;
    this.lake = f.lake;
    this.coastal = f.coastal;
    this.shore = f.shore;
    this.waterId = f.waterId;
    this.ck = this.w > 900 ? 2 : 1; // мелкие карты и так считаем точно
    const k = this.ck;
    this.cw = Math.ceil(this.w / k);
    this.ch = Math.ceil(this.h / k);
    // по океану, а не по любой воде: коридор не должен уходить через озеро
    this.cwater = buildCoarseWater(this.ocean, this.w, this.h, k, this.cw, this.ch);
    // Каналы (Суэц, Панама) — рукотворные: в данных Natural Earth воды там нет
    // вовсе, поэтому их по-прежнему прорубаем вручную. Естественные проливы
    // (Гибралтар, Босфор, Малакка) теперь видны сетке сами.
    if (this.mapType === 'earth') {
      for (const c of canalCoarseCells(this.w, this.h, k, this.cw, this.ch)) {
        this.cwater[c] = 1;
      }
    }
    const cn = this.cw * this.ch;
    this.coarsePrev = new Int32Array(cn);
    this.coarseSeen = new Int32Array(cn);
    this.coarseGen = 0;
    this.coarseG = new Int32Array(cn);
    this.coarseHeapCell = new Int32Array(cn + 1);
    this.coarseHeapKey = new Int32Array(cn + 1);
    this.corrStamp = new Int32Array(this.cells);
    this.corrGen = 0;
  }

  /** Достижима ли клетка воды `b` из клетки воды `a` морем — за O(1). */
  private sameWaterBody(a: number, b: number): boolean {
    return this.waterId[a] >= 0 && this.waterId[a] === this.waterId[b];
  }

  /** Лучший водный (океанский) сосед клетки берега — точка входа/выхода судна. */
  private oceanNeighbor(cell: number): number {
    if (this.ocean[cell]) return cell;
    const x = cell % this.w;
    const y = (cell / this.w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const nc = ny * this.w + nx;
        if (!this.ocean[nc]) continue;
        // по диагонали — только если не протискиваемся между двумя мысами
        if (dx && dy && this.terrain[y * this.w + nx] && this.terrain[ny * this.w + x]) continue;
        return nc;
      }
    }
    return -1;
  }

  // Точный A* по воде ВНУТРИ коридора, заданного грубым путём: коридор — это
  // блоки грубого пути, расширенные на один блок в каждую сторону. Так поиск
  // остаётся дешёвым (площадь ≈ длина пути × k²), а путь получается строго по
  // воде, клетка к клетке. Это наш аналог связки MiniMapTransformer +
  // SmoothingWaterTransformer из OpenFront. corridor = null — искать без
  // ограничения (страховка, если оптимистичный коридор оказался тупиком).
  private waterPathCorridor(startCell: number, goalCell: number, corridor: number[] | null): number[] | null {
    const w = this.w;
    const h = this.h;
    const N = this.cells;
    if (!this.ocean[startCell] || !this.ocean[goalCell]) return null;
    if (this.finePrev.length !== N) {
      this.finePrev = new Int32Array(N);
      this.fineDisc = new Int32Array(N);
      this.fineClosed = new Int32Array(N);
      this.fineG = new Int32Array(N);
      this.fineSteps = new Int32Array(N);
      this.heapCell = new Int32Array(N + 1);
      this.heapKey = new Int32Array(N + 1);
    }
    // маска коридора
    let mask = 0;
    if (corridor) {
      mask = ++this.corrGen;
      const k = this.ck;
      for (const cc of corridor) {
        const bx = cc % this.cw;
        const by = (cc / this.cw) | 0;
        for (let y = (by - 1) * k; y < (by + 2) * k; y++) {
          if (y < 0 || y >= h) continue;
          const row = y * w;
          for (let x = (bx - 1) * k; x < (bx + 2) * k; x++) {
            if (x < 0 || x >= w) continue;
            this.corrStamp[row + x] = mask;
          }
        }
      }
      // концы обязаны быть в коридоре, даже если порт у самого края блока
      this.corrStamp[startCell] = mask;
      this.corrStamp[goalCell] = mask;
    }
    const gx = goalCell % w;
    const gy = (goalCell / w) | 0;
    const gen = ++this.fineGen;
    const prev = this.finePrev;
    const disc = this.fineDisc;
    const closed = this.fineClosed;
    const g = this.fineG;
    const hc = this.heapCell;
    const hk = this.heapKey;
    let hn = 0;
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
        const l = i << 1;
        const r = l + 1;
        if (l <= hn && hk[l] < hk[m]) m = l;
        if (r <= hn && hk[r] < hk[m]) m = r;
        if (m === i) break;
        const tc = hc[m]; hc[m] = hc[i]; hc[i] = tc;
        const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
        i = m;
      }
    };
    const cheb = (c: number) => {
      const dx = Math.abs((c % w) - gx);
      const dy = Math.abs(((c / w) | 0) - gy);
      return dx > dy ? dx : dy;
    };
    const COAST = 3; // держимся открытого моря, у берега идём только в обход
    disc[startCell] = gen;
    g[startCell] = 0;
    prev[startCell] = -1;
    hc[++hn] = startCell;
    hk[hn] = cheb(startCell);
    let found = false;
    // Потолок на число раскрытых клеток. Без коридора (страховочный проход) поиск
    // иначе может обойти весь океан — это и был источник пиков по времени тика.
    // Такой же предохранитель стоит в waterPathFine (EXPLORE_CAP).
    let explored = 0;
    const cap = mask ? 200_000 : 60_000;
    while (hn > 0) {
      const c = hc[1];
      hc[1] = hc[hn]; hk[1] = hk[hn]; hn--;
      if (hn) siftDown(1);
      if (closed[c] === gen) continue;
      closed[c] = gen;
      if (++explored > cap) break;
      if (c === goalCell) { found = true; break; }
      const x = c % w;
      const y = (c / w) | 0;
      const gc = g[c];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nc = ny * w + nx;
          if (!this.ocean[nc] || disc[nc] === gen) continue;
          if (mask && this.corrStamp[nc] !== mask) continue;
          if (dx && dy && (this.terrain[y * w + nx] || this.terrain[ny * w + x])) continue;
          disc[nc] = gen;
          g[nc] = gc + 1 + (this.coastal[nc] ? COAST : 0);
          prev[nc] = c;
          hc[++hn] = nc;
          hk[hn] = g[nc] + cheb(nc);
          siftUp(hn);
        }
      }
    }
    if (!found) return null;
    const path: number[] = [];
    for (let c = goalCell; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    return path;
  }

  // Путь по воде между грубыми клетками (BFS, 8 направлений). Возвращает
  // список грубых индексов от start к goal или null, если пути нет.
  private waterPath(startC: number, goalC: number): number[] | null {
    if (this.cwater[startC] !== 1 || this.cwater[goalC] !== 1) return null;
    const cw = this.cw;
    const ch = this.ch;
    const prev = this.coarsePrev;
    const seen = this.coarseSeen;
    const g = this.coarseG;
    const hc = this.coarseHeapCell;
    const hk = this.coarseHeapKey;
    // Штамп поколения вместо prev.fill(-2): заливка обходит лишь малую часть
    // сетки, а fill стирал все 432 тыс. блоков на КАЖДЫЙ маршрут. Приём взят из
    // OpenFront (bumpTraversalGeneration / tileTraversalScratch).
    const gen = ++this.coarseGen;
    // Поиск — A* с эвристикой Чебышёва, а не «слепой» BFS. Раньше это была
    // обычная волна в ширину: без подсказки о направлении она обходила половину
    // океана (в профиле 18% тика). Эвристика тянет фронт к цели и режет число
    // раскрытых блоков в разы. Коридору оптимальность не нужна, но с
    // допустимой эвристикой путь всё равно кратчайший.
    const gx = goalC % cw;
    const gy = (goalC / cw) | 0;
    const cheb = (c: number) => {
      const dx = Math.abs((c % cw) - gx);
      const dy = Math.abs(((c / cw) | 0) - gy);
      return dx > dy ? dx : dy;
    };
    let hn = 0;
    const siftUp = (i: number) => {
      while (i > 1) {
        const par = i >> 1;
        if (hk[par] <= hk[i]) break;
        const tc = hc[par]; hc[par] = hc[i]; hc[i] = tc;
        const tk = hk[par]; hk[par] = hk[i]; hk[i] = tk;
        i = par;
      }
    };
    const siftDown = (i: number) => {
      for (;;) {
        let m = i;
        const l = i << 1;
        const r = l + 1;
        if (l <= hn && hk[l] < hk[m]) m = l;
        if (r <= hn && hk[r] < hk[m]) m = r;
        if (m === i) break;
        const tc = hc[m]; hc[m] = hc[i]; hc[i] = tc;
        const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
        i = m;
      }
    };
    seen[startC] = gen;
    g[startC] = 0;
    prev[startC] = -1;
    hc[++hn] = startC;
    hk[hn] = cheb(startC);
    let found = false;
    while (hn > 0) {
      const c = hc[1];
      hc[1] = hc[hn]; hk[1] = hk[hn]; hn--;
      if (hn) siftDown(1);
      if (c === goalC) { found = true; break; }
      const cx = c % cw;
      const cy = (c / cw) | 0;
      const gc = g[c];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nc = ny * cw + nx;
          if (this.cwater[nc] !== 1 || seen[nc] === gen) continue;
          // диагональ не должна срезать угол суши
          if (dx && dy) {
            if (this.cwater[cy * cw + nx] !== 1 && this.cwater[ny * cw + cx] !== 1) continue;
          }
          seen[nc] = gen;
          g[nc] = gc + 1;
          prev[nc] = c;
          hc[++hn] = nc;
          hk[hn] = gc + 1 + cheb(nc);
          siftUp(hn);
        }
      }
    }
    if (!found) return null;
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

  // Клетка суши ИМЕННО целевого материка рядом с водной клеткой (конец маршрута
  // десанта). Раньше брался nearestLandCell в радиусе ck*2 — любая суша, включая
  // свою и третьих лиц, из-за чего десант мог «высадиться» не на том берегу.
  private nearestLandCellOfIsland(waterCell: number, land: number, owner = -2): number {
    const w = this.w;
    const x = waterCell % w;
    const y = (waterCell / w) | 0;
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= this.h) continue;
        const stepX = Math.abs(dy) === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += stepX) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const c = ny * w + nx;
          if (!this.terrain[c] || this.landId[c] !== land) continue;
          if (owner !== -2 && this.owners[c] !== owner) continue;
          return c;
        }
      }
    }
    return -1;
  }

  // ближайшая клетка суши, принадлежащая игроку owner (для точки посадки десанта —
  // чтобы десант выходил именно с нашего берега, даже если вражеский ближе)
  private nearestOwnedLand(owner: number, px: number, py: number, maxR: number): number {
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          const c = y * this.w + x;
          if (this.terrain[c] && this.owners[c] === owner) return c;
        }
    }
    return -1;
  }

  // клетка воды «прибрежная», если рядом (4-соседство) есть суша — предпосчитано
  // при генерации карты (было 4 чтения массива на каждого соседа в цикле A*)
  private isCoastalCell(x: number, y: number): boolean {
    return this.coastal[y * this.w + x] === 1;
  }

  // Пиксельный A*-поиск морского пути СТРОГО по воде от водных клеток-засева
  // (seeds) до цели. Цель двух видов: targetLand >= 0 — вода, примыкающая к
  // материку с этим landId (десант к берегу); targetLand < 0 — сама точка (cx,cy)
  // (боевой корабль идёт в морскую зону). Путь держится открытой воды, проходит
  // проливы, по суше НЕ идёт. null — цель морем недостижима.
  private waterPathFine(
    seeds: number[],
    targetLand: number,
    cx: number,
    cy: number,
    landOwner = -2,
  ): number[] | null {
    const w = this.w, h = this.h, N = w * h;
    const gx = cx, gy = cy; // эвристика тянет к точке цели
    const R2 = 25; // окно «дошли вплотную к цели» (5 клеток)
    const pointMode = targetLand < 0; // цель — точка в море, а не берег материка
    if (this.finePrev.length !== N) {
      this.finePrev = new Int32Array(N);
      this.fineDisc = new Int32Array(N);
      this.fineClosed = new Int32Array(N);
      this.fineG = new Int32Array(N);
      this.fineSteps = new Int32Array(N);
      this.heapCell = new Int32Array(N + 1);
      this.heapKey = new Int32Array(N + 1);
    }
    const gen = ++this.fineGen;
    const prev = this.finePrev, disc = this.fineDisc, closed = this.fineClosed, g = this.fineG;
    const steps = this.fineSteps;
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
    // засев: все переданные водные клетки у берега игрока
    for (const c of seeds) {
      if (c < 0 || c >= N || this.terrain[c] || disc[c] === gen) continue;
      disc[c] = gen; g[c] = 0; steps[c] = 0; prev[c] = -1; hc[++hn] = c; hk[hn] = cheb(c);
    }
    if (hn === 0) return null;
    // Годится ли клетка суши как берег высадки: тот же материк и, если задан
    // landOwner, — именно его земля.
    //
    // Фильтр по владельцу обязателен, когда цель на НАШЕМ ЖЕ материке (общая
    // сухопутная граница): без него «берегом цели» оказывался и наш собственный
    // берег — он на том же материке, да ещё и с нулевой стоимостью рейса (это
    // засев). Десант «высаживался» на свою землю в двух клетках от старта, то есть
    // выплывал и сразу возвращался. Замер: 50% запусков по соседу с общей
    // границей. Снег (Антарктида, арктические острова) — тоже суша, поэтому
    // проверяем terrain > 0, а не === 1.
    const okLand = (lc: number) =>
      this.terrain[lc] > 0 &&
      this.landId[lc] === targetLand &&
      (landOwner === -2 || this.owners[lc] === landOwner);
    const touchesTarget = (x: number, y: number) =>
      (x > 0 && okLand(y * w + x - 1)) ||
      (x < w - 1 && okLand(y * w + x + 1)) ||
      (y > 0 && okLand((y - 1) * w + x)) ||
      (y < h - 1 && okLand((y + 1) * w + x));
    let endCell = -1, bestCell = -1, bestD = Infinity, explored = 0;
    let bestScore = Infinity; // лучшая оценка варианта высадки (см. ниже)
    let foundAt = -1; // на каком шаге нашли первый вариант
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
      const gc = g[c];
      const ex = x - gx, ey = y - gy, ed = ex * ex + ey * ey;
      if (pointMode) {
        // цель — морская точка: ближайшую всегда помним, финиш вплотную
        if (ed < bestD) { bestD = ed; bestCell = c; }
        if (ed <= 4) { endCell = c; break; }
      } else if (touchesTarget(x, y)) {
        // Вода у берега цели — кандидат на высадку. Оценка варианта:
        //   score = стоимость рейса (g) + LANDING_CLICK_W · удалённость от клика.
        // Раньше выбирался просто БЛИЖАЙШИЙ к клику берег. При клике внутрь
        // территории (а так обычно и целятся) ближайший к клику берег часто на
        // противоположной от нас стороне материка — десант шёл вокруг, и старт
        // получался с дальней точки. Замер на случайной карте: 28% запусков с
        // рейсом ≥1.5× длиннее необходимого, худший — 934 клетки вместо 174.
        // Длина рейса в ШАГАХ, а не в стоимости g: g содержит штраф ×3 за
        // прибрежные клетки, из-за которого «дорогой» дальний рейс проигрывал
        // высадке у самого нашего берега — при общей сухопутной границе десант
        // высаживался в двух клетках от старта вместо места клика.
        const score = steps[c] + LANDING_CLICK_W * Math.sqrt(ed);
        if (score < bestScore) { bestScore = score; bestCell = c; }
        if (foundAt < 0) foundAt = explored;
        // ДОШЛИ до места клика (вода у берега цели в пяти клетках от него) —
        // дальше искать нечего, это и есть желаемая высадка. Эвристика поиска
        // тянет фронт к клику, поэтому такой финиш и дёшев, и предсказуем.
        if (ed <= R2) { endCell = c; break; }
        // Страховка на случай, когда до клика морем не добраться вовсе: тогда
        // берём лучший из найденных вариантов, изучив ограниченный запас. Предел
        // должен быть БОЛЬШИМ: первый вариант часто находится у нашего же берега,
        // и маленький запас (пробовал 1200) обрывал поиск задолго до клика — из-за
        // этого вес близости к клику вообще ни на что не влиял.
        if (explored > foundAt + LANDING_SEARCH_SLACK) break;
      }
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
          steps[nc] = steps[c] + 1;
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

  // Соседи по 4 направлениям в переиспользуемый буфер; возвращает их число.
  // В горячих циклах (стройка фронта, шаг атаки) это заметно дешевле, чем
  // forNeighbors с колбэком: там на КАЖДУЮ клетку создаётся замыкание, которое
  // к тому же мешает движку встроить вызов. Так же сделано в OpenFront
  // (GameMap.neighbors4(tile, buf) с буферами-полями вместо forEachNeighbor).
  private nbuf: Int32Array = new Int32Array(4);
  private neighbors4(c: number, buf: Int32Array): number {
    const x = c % this.w;
    let n = 0;
    if (x > 0) buf[n++] = c - 1;
    if (x < this.w - 1) buf[n++] = c + 1;
    if (c >= this.w) buf[n++] = c - this.w;
    if (c < this.cells - this.w) buf[n++] = c + this.w;
    return n;
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
      hurtTick: -1000,
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
    p.troops = (150 + cellFactor(p.cells) * 12) * p.maxMul + 1500;
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
    this.warships = this.warships.filter((s) => s.owner !== id);
    this.drones = this.drones.filter((d) => d.owner !== id && d.target !== id);
    this.trucks = this.trucks.filter((t) => t.owner !== id);
    this.bullets = this.bullets.filter((b) => b.owner !== id);
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
    this.warships = this.warships.filter((s) => s.owner !== p.id);
    this.trucks = this.trucks.filter((t) => t.owner !== p.id);
    this.bullets = this.bullets.filter((b) => b.owner !== p.id);
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






  // Вода, примыкающая к нашему берегу: и засев морского маршрута, и множество
  // достижимых нами водных бассейнов. Один проход по своим клеткам вместо двух.
  private ownShoreWater(playerId: number): { seeds: number[]; comps: Set<number> } {
    const seeds: number[] = [];
    const comps = new Set<number>();
    const w = this.w;
    const h = this.h;
    const add = (n: number) => {
      if (this.terrain[n] || !this.ocean[n]) return; // только океан, не озёра
      seeds.push(n);
      comps.add(this.waterId[n]);
    };
    for (const c of this.playerCells(playerId)) {
      if (this.owners[c] !== playerId) continue;
      const x = c % w;
      const y = (c / w) | 0;
      if (x > 0) add(c - 1);
      if (x < w - 1) add(c + 1);
      if (y > 0) add(c - w);
      if (y < h - 1) add(c + w);
    }
    return { seeds, comps };
  }

  // Морской десант: маршрут по воде от берега игрока к берегу цели (в обход суши)
  private launchBoat(playerId: number, targetCell: number, troops: number): boolean {
    const p = this.players.get(playerId);
    if (!p?.alive || troops < 10) return false;
    // не больше 3 своих десантных кораблей в пути одновременно
    let afloat = 0;
    for (const b of this.boats) if (b.player === playerId && ++afloat >= MAX_BOATS) break;
    if (afloat >= MAX_BOATS) return false;
    // наш выход к морю: вода у своего берега + бассейны, куда мы вообще можем плыть
    const own = this.ownShoreWater(playerId);
    if (own.seeds.length === 0) return false; // нет выхода к морю
    // Клетка высадки и точка отправки выбираются ОДНИМ поиском: засеваем все свои
    // выходы к морю с нулевой ценой, и A* сам находит вариант высадки с лучшей
    // оценкой «короткий рейс + рядом с кликом» (см. waterPathFine), а началом пути
    // оказывается тот наш берег, с которого этот рейс и идёт — то есть ближайший
    // к цели по воде. Это логика closestShoreByWater из OpenFront.
    const lx0 = targetCell % this.w;
    const ly0 = (targetCell / this.w) | 0;
    const targetLand = this.landId[targetCell];
    // Высаживаемся на берег ТОГО, по кому кликнули (владелец кликнутой клетки;
    // 0 — нейтраль). Иначе на своём же материке «берегом цели» оказывается наш
    // собственный берег, и лодка возвращается, не доплыв до врага.
    const victim = this.owners[targetCell];
    const fine = this.waterPathFine(own.seeds, targetLand, lx0, ly0, victim);
    if (!fine) return false;
    // фактическая клетка высадки — берег цели у конца найденного маршрута
    const arr = fine[fine.length - 1];
    const landCell = this.nearestLandCellOfIsland(arr, targetLand, victim);
    if (landCell < 0) return false;
    const lx = landCell % this.w;
    const ly = (landCell / this.w) | 0;
    // отправка десанта на чужую территорию — уже объявление войны: жертва
    // становится врагом сразу (её корабли начинают бить наш десант в пути)
    if (victim > 0 && victim !== playerId) this.markHostile(playerId, victim);
    // Засев — вода, примыкающая к нашей суше, поэтому наш берег ровно в одной
    // клетке от начала маршрута. Если его там нет — что-то не так, и лодку лучше
    // не выпускать вовсе, чем стартовать из открытого моря (именно так выглядел
    // баг «десант стартует с моря»: радиус поиска берега не находил сушу, и
    // стартовой точкой становилась сама водная клетка).
    const startCell = fine[0];
    const sxw = startCell % this.w, syw = (startCell / this.w) | 0;
    const embark = this.nearestOwnedLand(playerId, sxw, syw, 2);
    if (embark < 0) return false;
    const sx = embark % this.w;
    const sy = (embark / this.w) | 0;
    // Путь: наш берег → клетки A* (строго вода) → берег высадки. Засев A* у берега,
    // поэтому переход берег↔вода — всего пара клеток (лодка стартует ОТ берега и
    // причаливает К берегу), а вся середина маршрута идёт по воде.
    // Спрямляем плотный водный путь так, что КАЖДЫЙ отрезок проверен как
    // полностью водный (раньше было chaikin + Дуглас–Пекер с eps 0.8: срезание
    // углов и допуск давали лодке заезжать на мыс примерно на клетку).
    const path: number[] = [sx + 0.5, sy + 0.5];
    for (const c of smoothWaterPath(this.terrain, this.w, this.h, fine)) {
      path.push((c % this.w) + 0.5, ((c / this.w) | 0) + 0.5);
    }
    path.push((landCell % this.w) + 0.5, ((landCell / this.w) | 0) + 0.5);
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

  // сколько боевых кораблей у игрока (для цены следующего)
  private warshipCount(playerId: number): number {
    return this.warships.reduce((n, s) => (s.owner === playerId ? n + 1 : n), 0);
  }

  // Маршрут боевого корабля по воде от точки (fromX,fromY) к морской зоне (wx,wy).
  // Пиксельный A* (как у десанта) — строго по воде, устойчив к узким проливам.
  private warRoute(fromX: number, fromY: number, wx: number, wy: number): { path: number[]; cum: number[]; totalLen: number } | null {
    const w = this.w, h = this.h;
    const seeds: number[] = [];
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dy * dy > 16) continue;
        const x = fromX + dx, y = fromY + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const c = y * w + x;
        if (!this.terrain[c]) seeds.push(c);
      }
    if (!seeds.length) return null;
    const fine = this.waterPathFine(seeds, -1, wx, wy);
    if (!fine) return null;
    // спрямление с проверкой воды на каждом отрезке (см. launchBoat)
    const path: number[] = [fromX + 0.5, fromY + 0.5];
    for (const c of smoothWaterPath(this.terrain, w, h, fine)) {
      path.push((c % w) + 0.5, ((c / w) | 0) + 0.5);
    }
    path.push(wx + 0.5, wy + 0.5);
    const cum: number[] = [0];
    for (let i = 2; i < path.length; i += 2)
      cum.push(cum[cum.length - 1] + Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]));
    return { path, cum, totalLen: cum[cum.length - 1] || 1 };
  }

  // Выпустить боевой корабль из ближайшего порта в зону (клетка клика). Корабль
  // доплывёт до зоны и будет патрулировать её, стреляя по вражеским судам.
  launchWarship(playerId: number, cell: number): string | null {
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return 'Сначала выберите старт';
    if (cell < 0 || cell >= this.cells) return null;
    // центр зоны — ближайшая вода к точке клика
    const [wx, wy] = this.nearestWaterFine(cell % this.w, (cell / this.w) | 0, 40);
    const targetWater = wy * this.w + wx;
    if (this.terrain[targetWater]) return 'Рядом нет моря';
    const cost = warshipCost(this.warshipCount(playerId));
    if (p.money < cost) return `Нужно ${cost.toLocaleString('ru-RU')}`;
    // ближайший свой достроенный порт к зоне
    let port = -1;
    let bestD = Infinity;
    for (const b of this.buildings) {
      if (b.type !== 'port' || b.owner !== playerId || this.tickNo < b.readyTick) continue;
      const dx = (b.cell % this.w) - wx;
      const dy = ((b.cell / this.w) | 0) - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; port = b.cell; }
    }
    if (port < 0) return 'Нужен торговый порт';
    const route = this.warRoute(port % this.w, (port / this.w) | 0, wx, wy);
    if (!route) return 'Нет морского пути к зоне';
    p.money -= cost;
    this.warships.push({
      id: this.nextWarshipId++,
      owner: playerId,
      x: (port % this.w) + 0.5,
      y: ((port / this.w) | 0) + 0.5,
      path: route.path,
      cum: route.cum,
      totalLen: route.totalLen,
      traveled: 0,
      moving: true,
      patrolX: wx + 0.5,
      patrolY: wy + 0.5,
      patrolAng: 0,
      hp: WARSHIP_HP,
      cooldown: 0,
      hits: 0,
      repairing: false,
      healTicks: 0,
      healRate: 0,
    });
    return null;
  }

  // Приказ выделенным кораблям: идти в новую зону (от текущей позиции) и патрулировать
  moveWarships(playerId: number, ids: number[], cell: number) {
    if (cell < 0 || cell >= this.cells || !ids?.length) return;
    const [wx, wy] = this.nearestWaterFine(cell % this.w, (cell / this.w) | 0, 40);
    if (this.terrain[wy * this.w + wx]) return;
    const set = new Set(ids);
    for (const s of this.warships) {
      if (s.owner !== playerId || !set.has(s.id)) continue;
      const route = this.warRoute(Math.round(s.x) | 0, Math.round(s.y) | 0, wx, wy);
      if (!route) continue;
      s.path = route.path;
      s.cum = route.cum;
      s.totalLen = route.totalLen;
      s.traveled = 0;
      s.moving = true;
      s.patrolX = wx + 0.5;
      s.patrolY = wy + 0.5;
    }
  }

  // ближайший свой достроенный порт к точке (x,y), клетка или -1
  private nearestOwnPort(playerId: number, x: number, y: number): number {
    let port = -1, bestD = Infinity;
    for (const b of this.buildings) {
      if (b.type !== 'port' || b.owner !== playerId || this.tickNo < b.readyTick) continue;
      const dx = (b.cell % this.w) - x, dy = ((b.cell / this.w) | 0) - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; port = b.cell; }
    }
    return port;
  }

  private stepWarships() {
    const R2 = WARSHIP_RANGE * WARSHIP_RANGE;
    const w = this.w, h = this.h;
    for (const s of this.warships) {
      const p = this.players.get(s.owner);
      if (!p?.alive) { s.hp = 0; continue; }
      // рядом ли СВОЙ порт (чинимся только в своём порту; цель могла быть
      // захвачена, пока корабль плыл — тогда ремонт не начинаем / прерываем)
      const nearOwnPort = () => {
        const port = this.nearestOwnPort(s.owner, s.x, s.y);
        if (port < 0) return false;
        const px = port % w, py = (port / w) | 0;
        return (px - s.x) ** 2 + (py - s.y) ** 2 <= 26 * 26;
      };
      // стоим в порту на ремонте — плавно восполняем hp, потом обратно в зону
      if (s.healTicks > 0) {
        if (!nearOwnPort()) { s.healTicks = 0; s.repairing = false; s.moving = false; continue; } // порт уже не наш — прекращаем
        s.hp = Math.min(WARSHIP_HP, s.hp + s.healRate);
        if (--s.healTicks <= 0) {
          s.hp = WARSHIP_HP;
          s.hits = 0;
          s.repairing = false;
          // возвращаемся патрулировать свою зону
          const route = this.warRoute(Math.round(s.x) | 0, Math.round(s.y) | 0, Math.round(s.patrolX) | 0, Math.round(s.patrolY) | 0);
          if (route) { s.path = route.path; s.cum = route.cum; s.totalLen = route.totalLen; s.traveled = 0; s.moving = true; }
        }
        continue; // на ремонте не двигается и не стреляет
      }
      if (s.moving) {
        s.traveled += WARSHIP_SPEED;
        if (s.traveled >= s.totalLen) {
          s.moving = false;
          if (s.repairing) {
            // дошли до цели — встаём на ремонт ТОЛЬКО если это по-прежнему свой
            // порт (его могли захватить, пока плыли); иначе просто патрулируем
            if (nearOwnPort()) {
              s.healTicks = Math.max(REPAIR_TICKS_PER_HIT, s.hits * REPAIR_TICKS_PER_HIT);
              s.healRate = (WARSHIP_HP - s.hp) / s.healTicks;
            } else {
              s.repairing = false;
            }
          }
        } else {
          const d = s.traveled;
          let seg = 0;
          while (seg < s.cum.length - 2 && s.cum[seg + 1] < d) seg++;
          const segLen = s.cum[seg + 1] - s.cum[seg] || 1;
          const t = (d - s.cum[seg]) / segLen;
          s.x = s.path[seg * 2] + (s.path[(seg + 1) * 2] - s.path[seg * 2]) * t;
          s.y = s.path[seg * 2 + 1] + (s.path[(seg + 1) * 2 + 1] - s.path[seg * 2 + 1]) * t;
        }
      }
      if (!s.moving && !s.repairing) {
        // патруль по кругу вокруг центра зоны; держимся воды
        s.patrolAng += WARSHIP_PATROL_SPD;
        let tx = s.patrolX + Math.cos(s.patrolAng) * WARSHIP_PATROL_R;
        let ty = s.patrolY + Math.sin(s.patrolAng) * WARSHIP_PATROL_R;
        const cx = Math.round(tx), cy = Math.round(ty);
        if (cx < 0 || cy < 0 || cx >= w || cy >= h || this.terrain[cy * w + cx]) {
          const [nwx, nwy] = this.nearestWaterFine(
            Math.max(0, Math.min(w - 1, cx)),
            Math.max(0, Math.min(h - 1, cy)),
            WARSHIP_PATROL_R
          );
          tx = nwx + 0.5; ty = nwy + 0.5;
        }
        const dx = tx - s.x, dy = ty - s.y;
        const dist = Math.hypot(dx, dy) || 1;
        const step = Math.min(WARSHIP_SPEED, dist);
        s.x += (dx / dist) * step;
        s.y += (dy / dist) * step;
      }
      // стрельба: по каждой цели — только 1 свой снаряд в полёте; видя несколько
      // целей сразу, корабль даёт залп по РАЗНЫМ целям (до лимита в 3 пули).
      if (s.cooldown > 0) { s.cooldown--; continue; }
      const busy = new Set<number>(); // цели, по которым уже летит наш снаряд (id по типу)
      let afloat = 0;
      for (const b of this.bullets) if (b.fromId === s.id) { afloat++; busy.add(b.targetKind.charCodeAt(0) * 1e7 + b.targetId); }
      let slots = 3 - afloat;
      if (slots <= 0) continue;
      // все вражеские цели в радиусе (кроме уже обстреливаемых), ближние первыми
      const cands: { d: number; kind: 'war' | 'trade' | 'boat'; id: number }[] = [];
      const key = (k: string, id: number) => k.charCodeAt(0) * 1e7 + id;
      for (const ts of this.tradeShips) {
        if (ts.owner === s.owner || this.relation(s.owner, ts.owner) !== 'hostile') continue;
        const d = (ts.x - s.x) ** 2 + (ts.y - s.y) ** 2;
        if (d <= R2 && !busy.has(key('t', ts.id))) cands.push({ d, kind: 'trade', id: ts.id });
      }
      for (const bt of this.boats) {
        if (bt.player === s.owner || this.relation(s.owner, bt.player) !== 'hostile') continue;
        const d = (bt.x - s.x) ** 2 + (bt.y - s.y) ** 2;
        if (d <= R2 && !busy.has(key('b', bt.id))) cands.push({ d, kind: 'boat', id: bt.id });
      }
      for (const w2 of this.warships) {
        if (w2 === s || w2.owner === s.owner || this.relation(s.owner, w2.owner) !== 'hostile') continue;
        if (w2.healTicks > 0) continue; // корабль на починке в порту — не атакуем
        const d = (w2.x - s.x) ** 2 + (w2.y - s.y) ** 2;
        if (d <= R2 && !busy.has(key('w', w2.id))) cands.push({ d, kind: 'war', id: w2.id });
      }
      cands.sort((a, b) => a.d - b.d);
      let fired = 0;
      for (const t of cands) {
        if (slots <= 0) break;
        this.bullets.push({
          id: this.nextBulletId++,
          owner: s.owner,
          fromId: s.id,
          x: s.x,
          y: s.y,
          targetId: t.id,
          targetKind: t.kind,
          dmg: WARSHIP_DAMAGE,
        });
        slots--;
        fired++;
      }
      if (fired) s.cooldown = WARSHIP_COOLDOWN;
    }
    if (this.warships.some((s) => s.hp <= 0)) {
      this.warships = this.warships.filter((s) => s.hp > 0);
    }
  }

  // Пули: пиксель летит и догоняет цель; при попадании — урон. Урон боевому
  // кораблю копит попадания (время ремонта) и при ≤50% отправляет его в порт.
  private stepBullets() {
    if (!this.bullets.length) return;
    let boatKilled = false;
    let droneKilled = false;
    for (const b of this.bullets) {
      // цель по типу; если её уже нет (потоплена / десант успел высадиться) — пуля мажет
      const tgt =
        b.targetKind === 'war'
          ? this.warships.find((s) => s.id === b.targetId && s.healTicks <= 0) // на починке — неуязвим
          : b.targetKind === 'boat'
            ? this.boats.find((s) => s.id === b.targetId && s.troops >= 1)
            : b.targetKind === 'drone'
              ? this.drones.find((s) => s.id === b.targetId && !s.done)
              : this.tradeShips.find((s) => s.id === b.targetId && !s.done);
      if (!tgt) { b.dmg = 0; continue; } // цель исчезла — пуля гаснет (промах)
      const dx = tgt.x - b.x, dy = tgt.y - b.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist <= BULLET_SPEED + 1.5) {
        // попадание
        if (b.targetKind === 'war') {
          const s = tgt as Warship;
          s.hp -= b.dmg;
          s.hits++;
          // при ≤50% и если ещё не чинится — сам плывёт в ближайший свой порт
          if (!s.repairing && s.hp > 0 && s.hp <= WARSHIP_HP * WARSHIP_REPAIR_AT) {
            const port = this.nearestOwnPort(s.owner, s.x, s.y);
            if (port >= 0) {
              const route = this.warRoute(Math.round(s.x) | 0, Math.round(s.y) | 0, port % this.w, (port / this.w) | 0);
              if (route) {
                s.repairing = true;
                s.path = route.path; s.cum = route.cum; s.totalLen = route.totalLen; s.traveled = 0; s.moving = true;
              }
            }
          }
        } else if (b.targetKind === 'boat') {
          (tgt as Boat).troops = 0; // десант потоплен
          boatKilled = true;
        } else if (b.targetKind === 'drone') {
          const dr = tgt as Drone;
          dr.done = true; // ракета ПВО догнала дрон — сбит
          droneKilled = true;
          this.droneBomb(dr); // падает и взрывается с уроном по области, как сброшенная бомба
        } else {
          const ts = tgt as TradeShip;
          ts.done = true;
          this.noticeTradeLost(ts.owner, b.owner, ts.x, ts.y); // место гибели ≈ где корабль-убийца
        }
        b.dmg = 0; // пуля отработала
      } else {
        b.x += (dx / dist) * BULLET_SPEED;
        b.y += (dy / dist) * BULLET_SPEED;
      }
    }
    this.bullets = this.bullets.filter((b) => b.dmg > 0);
    this.tradeShips = this.tradeShips.filter((s) => !s.done);
    if (boatKilled) this.boats = this.boats.filter((b) => b.troops >= 1);
    if (droneKilled) this.drones = this.drones.filter((d) => !d.done);
  }

  bulletsPub(): number[] {
    const out: number[] = [];
    for (const b of this.bullets) out.push(+b.x.toFixed(1), +b.y.toFixed(1));
    return out;
  }

  warshipsPub(): WarshipPub[] {
    return this.warships.map((s) => ({
      id: s.id,
      owner: s.owner,
      x: +s.x.toFixed(1),
      y: +s.y.toFixed(1),
      hp: Math.max(0, Math.min(1, s.hp / WARSHIP_HP)),
    }));
  }

  // Дорога по СУШЕ между зданиями: A* с дешёвой сушей и дорогой водой — путь идёт
  // по земле, а короткие проливы пересекает (штраф не даёт бежать по открытой воде).
  private landPathFine(fromCell: number, toCell: number): number[] | null {
    const w = this.w, h = this.h, N = w * h, t = this.terrain;
    const sx = fromCell % w, sy = (fromCell / w) | 0, gx = toCell % w, gy = (toCell / w) | 0;
    const pad = 24;
    const minx = Math.max(0, Math.min(sx, gx) - pad), maxx = Math.min(w - 1, Math.max(sx, gx) + pad);
    const miny = Math.max(0, Math.min(sy, gy) - pad), maxy = Math.min(h - 1, Math.max(sy, gy) + pad);
    if (this.finePrev.length !== N) {
      this.finePrev = new Int32Array(N); this.fineDisc = new Int32Array(N);
      this.fineClosed = new Int32Array(N); this.fineG = new Int32Array(N);
      this.heapCell = new Int32Array(N + 1); this.heapKey = new Int32Array(N + 1);
    }
    const gen = ++this.fineGen;
    const prev = this.finePrev, disc = this.fineDisc, closed = this.fineClosed, g = this.fineG;
    const hc = this.heapCell, hk = this.heapKey;
    let hn = 0;
    const cheb = (c: number) => { const dx = Math.abs((c % w) - gx), dy = Math.abs(((c / w) | 0) - gy); return dx > dy ? dx : dy; };
    const up = (i: number) => { while (i > 1) { const p = i >> 1; if (hk[p] <= hk[i]) break; const tc = hc[p]; hc[p] = hc[i]; hc[i] = tc; const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk; i = p; } };
    const down = (i: number) => { for (;;) { let m = i; const l = i << 1, r = l + 1; if (l <= hn && hk[l] < hk[m]) m = l; if (r <= hn && hk[r] < hk[m]) m = r; if (m === i) break; const tc = hc[m]; hc[m] = hc[i]; hc[i] = tc; const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk; i = m; } };
    const WATER_PEN = 12;
    disc[fromCell] = gen; g[fromCell] = 0; prev[fromCell] = -1; hc[++hn] = fromCell; hk[hn] = cheb(fromCell);
    let found = false;
    while (hn > 0) {
      const c = hc[1]; hc[1] = hc[hn]; hk[1] = hk[hn]; hn--; if (hn) down(1);
      if (closed[c] === gen) continue;
      closed[c] = gen;
      if (c === toCell) { found = true; break; }
      const x = c % w, y = (c / w) | 0, gc = g[c];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < minx || ny < miny || nx > maxx || ny > maxy) continue;
          const nc = ny * w + nx;
          if (closed[nc] === gen) continue;
          const ng = gc + (t[nc] ? 1 : WATER_PEN);
          if (disc[nc] !== gen || ng < g[nc]) {
            disc[nc] = gen; g[nc] = ng; prev[nc] = c;
            if (hn < N) { hc[++hn] = nc; hk[hn] = ng + cheb(nc); up(hn); }
          }
        }
    }
    if (!found) return null;
    const path: number[] = [];
    for (let c = toCell; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    return path;
  }

  // Прямой отрезок по одной оси: возвращает true и заполняет cells, если весь
  // путь идёт по суше (все клетки — земля).
  private hvSeg(x0: number, y0: number, x1: number, y1: number, cells: number[]): boolean {
    const t = this.terrain, w = this.w;
    if (x0 === x1) {
      const s = y0 <= y1 ? 1 : -1;
      for (let y = y0; ; y += s) { const c = y * w + x0; if (!t[c]) return false; cells.push(c); if (y === y1) break; }
    } else {
      const s = x0 <= x1 ? 1 : -1;
      for (let x = x0; ; x += s) { const c = y0 * w + x; if (!t[c]) return false; cells.push(c); if (x === x1) break; }
    }
    return true;
  }

  // Ребро дороги с прямыми углами: пробуем Г-образный путь (одно колено под 90°)
  // по суше; если ни одно колено не помещается на земле — падаем на A* по суше
  // (пересечение пролива). Так на одном материке дороги ровные, углы прямые.
  private orthEdge(a: number, b: number): number[] | null {
    const w = this.w;
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    const c1: number[] = [], c2: number[] = [];
    if (this.hvSeg(ax, ay, bx, ay, c1) && this.hvSeg(bx, ay, bx, by, c2)) return c1.concat(c2.slice(1));
    const d1: number[] = [], d2: number[] = [];
    if (this.hvSeg(ax, ay, ax, by, d1) && this.hvSeg(ax, by, bx, by, d2)) return d1.concat(d2.slice(1));
    return this.landPathFine(a, b);
  }

  // Дорожная сеть игрока (кэш). Узлы — заводы/города/порты. Каждый узел —
  // перекрёсток: до 4 дорог в любую сторону. Сеть НАРАЩИВАЕТСЯ инкрементально:
  // существующие дороги сохраняются, новое здание лишь ДОБАВЛЯЕТ дорогу к
  // ближайшему узлу со свободным перекрёстком (маршруты не переприкладываются).
  private getRoadNet(owner: number) {
    const cached = this.roadNet.get(owner);
    if (cached && cached.ver === this.roadVer) return cached;
    const R2 = FACTORY_RANGE * FACTORY_RANGE;
    const MAX_DEG = 4; // перекрёсток: максимум 4 дороги из любого узла
    const nodes: number[] = [];
    const nodeSet = new Set<number>();
    const revenue = new Set<number>();
    for (const b of this.buildings) {
      if (b.owner !== owner || this.tickNo < b.readyTick) continue;
      if (b.type === 'factory') { nodes.push(b.cell); nodeSet.add(b.cell); }
      else if (b.type === 'city' || b.type === 'port') { nodes.push(b.cell); nodeSet.add(b.cell); revenue.add(b.cell); }
    }
    const w = this.w, cells = this.cells;
    const key = (a: number, b: number) => (a < b ? a * cells + b : b * cells + a);
    // персистентный набор дорог: сохраняем то, что уже проложено
    let committed = this.roadEdges.get(owner);
    if (!committed) { committed = new Map(); this.roadEdges.set(owner, committed); }
    // выкидываем только те дороги, чьи концы больше не существуют/не наши
    for (const k of [...committed.keys()]) {
      const a = Math.floor(k / cells), b = k % cells;
      if (!nodeSet.has(a) || !nodeSet.has(b)) committed.delete(k);
    }
    // adj + союзы (union-find) + степени из уцелевших дорог
    const adj = new Map<number, number[]>();
    const uf = new Map<number, number>(); for (const n of nodes) uf.set(n, n);
    const find = (x: number): number => { while (uf.get(x) !== x) { uf.set(x, uf.get(uf.get(x)!)!); x = uf.get(x)!; } return x; };
    const deg = new Map<number, number>();
    for (const k of committed.keys()) {
      const a = Math.floor(k / cells), b = k % cells;
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
      uf.set(find(a), find(b));
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    // ДОБАВЛЯЕМ дороги только чтобы связать ещё не связанные узлы (по возрастанию
    // расстояния), не трогая существующие; перекрёстки — максимум 4 дороги
    const cand: { a: number; b: number; d: number }[] = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = (a % w) - (b % w), dy = ((a / w) | 0) - ((b / w) | 0);
        const d = dx * dx + dy * dy;
        if (d > R2) continue;
        cand.push({ a, b, d });
      }
    cand.sort((p, q) => p.d - q.d);
    for (const { a, b } of cand) {
      if (find(a) === find(b)) continue; // уже связаны (в т.ч. через старые дороги)
      if ((deg.get(a) ?? 0) >= MAX_DEG || (deg.get(b) ?? 0) >= MAX_DEG) continue;
      const path = this.orthEdge(a, b);
      if (!path) continue;
      committed.set(key(a, b), path);
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
      uf.set(find(a), find(b));
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    const net = { ver: this.roadVer, adj, edge: committed, revenue };
    this.roadNet.set(owner, net);
    return net;
  }

  // Маршрут грузовика: обход (эйлеров тур) связной компоненты дорог от завода,
  // посещая ВСЕ достижимые города/порты (в т.ч. в чужих зонах, если есть дорога),
  // и возврат на завод. Оплата 10к — при первом заходе на каждое здание.
  private buildTruckTour(owner: number, factoryCell: number):
    { cells: number[]; pay: { at: number; cell: number }[] } | null {
    const net = this.getRoadNet(owner);
    if (!net.adj.has(factoryCell)) return null;
    // остовное дерево BFS от завода
    const parent = new Map<number, number>([[factoryCell, -1]]);
    const children = new Map<number, number[]>();
    const q = [factoryCell];
    for (let hd = 0; hd < q.length; hd++) {
      const c = q[hd];
      for (const nb of net.adj.get(c) || []) {
        if (parent.has(nb)) continue;
        parent.set(nb, c);
        (children.get(c) ?? children.set(c, []).get(c)!).push(nb);
        q.push(nb);
      }
    }
    const key = (a: number, b: number) => (a < b ? a * this.cells + b : b * this.cells + a);
    const cells: number[] = [factoryCell];
    const pay: { at: number; cell: number }[] = [];
    const paid = new Set<number>();
    const appendEdge = (a: number, b: number) => {
      let p = net.edge.get(key(a, b));
      if (!p) { cells.push(b); return; }
      if (p[0] !== a) p = [...p].reverse();
      for (let i = 1; i < p.length; i++) cells.push(p[i]); // без дубля стартовой клетки
    };
    // итеративный DFS (стек кадров: node + индекс ребёнка)
    const stack: { node: number; ci: number }[] = [{ node: factoryCell, ci: 0 }];
    if (net.revenue.has(factoryCell) && !paid.has(factoryCell)) { paid.add(factoryCell); pay.push({ at: cells.length - 1, cell: factoryCell }); }
    while (stack.length) {
      const fr = stack[stack.length - 1];
      const kids = children.get(fr.node) || [];
      if (fr.ci < kids.length) {
        const ch = kids[fr.ci++];
        appendEdge(fr.node, ch);
        if (net.revenue.has(ch) && !paid.has(ch)) { paid.add(ch); pay.push({ at: cells.length - 1, cell: ch }); }
        stack.push({ node: ch, ci: 0 });
      } else {
        stack.pop();
        if (stack.length) appendEdge(fr.node, stack[stack.length - 1].node); // возврат к родителю
      }
    }
    return { cells, pay };
  }

  // Грузовики заводов: выпуск. Каждый достроенный завод раз в интервал шлёт
  // грузовик по дорогам к своим городам/портам в радиусе и обратно.
  private spawnTrucks() {
    for (const b of this.buildings) {
      if (b.type !== 'factory' || this.tickNo < b.readyTick) continue;
      if (this.tickNo < b.nextShipTick) continue;
      if (this.trucks.some((t) => t.factoryCell === b.cell && t.owner === b.owner)) continue;
      b.nextShipTick = this.tickNo + TRUCK_INTERVAL;
      const tour = this.buildTruckTour(b.owner, b.cell);
      if (!tour || tour.pay.length === 0) continue; // нет соединённых зданий
      // клетки маршрута → мировые точки + накопленная длина
      const path: number[] = [];
      const cum: number[] = [0];
      for (let i = 0; i < tour.cells.length; i++) {
        const c = tour.cells[i];
        const px = (c % this.w) + 0.5, py = ((c / this.w) | 0) + 0.5;
        path.push(px, py);
        if (i > 0) cum.push(cum[cum.length - 1] + Math.hypot(px - path[(i - 1) * 2], py - path[(i - 1) * 2 + 1]));
      }
      const payDist = tour.pay.map((p2) => cum[p2.at]);
      const payCell = tour.pay.map((p2) => p2.cell);
      this.trucks.push({
        id: this.nextTruckId++,
        owner: b.owner,
        factoryCell: b.cell,
        path,
        cum,
        totalLen: cum[cum.length - 1] || 1,
        traveled: 0,
        payDist,
        payCell,
        payIdx: 0,
        x: path[0],
        y: path[1],
        done: false,
      });
    }
  }

  private stepTrucks() {
    let any = false;
    for (const t of this.trucks) {
      const p = this.players.get(t.owner);
      const fac = this.buildings.find((b) => b.cell === t.factoryCell && b.owner === t.owner && b.type === 'factory');
      if (!p?.alive || !fac) { t.done = true; any = true; continue; }
      t.traveled += TRUCK_SPEED;
      // оплата за пройденные здания (10к, если здание ещё наше)
      while (t.payIdx < t.payDist.length && t.traveled >= t.payDist[t.payIdx]) {
        const cell = t.payCell[t.payIdx];
        if (this.buildings.some((bd) => bd.cell === cell && bd.owner === t.owner)) {
          p.money += TRUCK_REWARD;
          if (!p.bot) this.tradeEarnings.push({ x: (cell % this.w) + 0.5, y: ((cell / this.w) | 0) + 0.5, amount: TRUCK_REWARD, owner: t.owner });
        }
        t.payIdx++;
      }
      if (t.traveled >= t.totalLen) {
        // вернулся на завод — рейс окончен, следующий через интервал
        fac.nextShipTick = this.tickNo + TRUCK_INTERVAL;
        t.done = true; any = true;
        continue;
      }
      // позиция вдоль ломаной
      const d = t.traveled;
      let seg = 0;
      while (seg < t.cum.length - 2 && t.cum[seg + 1] < d) seg++;
      const segLen = (t.cum[seg + 1] - t.cum[seg]) || 1;
      const f = (d - t.cum[seg]) / segLen;
      t.x = t.path[seg * 2] + (t.path[(seg + 1) * 2] - t.path[seg * 2]) * f;
      t.y = t.path[seg * 2 + 1] + (t.path[(seg + 1) * 2 + 1] - t.path[seg * 2 + 1]) * f;
    }
    if (any) this.trucks = this.trucks.filter((t) => !t.done);
  }

  trucksPub(): TruckPub[] {
    return this.trucks.map((t) => ({ x: +t.x.toFixed(1), y: +t.y.toFixed(1), owner: t.owner }));
  }

  // Дороги для отрисовки: рёбра дорожных сетей всех игроков (проложены по суше),
  // прорежены для компактности. Кэшируются по версии сети.
  roadsPub(): number[][] {
    if (this.roadsCache && this.roadsCache.ver === this.roadVer) return this.roadsCache.data;
    const out: number[][] = [];
    const owners = new Set<number>();
    for (const b of this.buildings) if (b.type === 'factory' && this.tickNo >= b.readyTick) owners.add(b.owner);
    for (const o of owners) {
      const net = this.getRoadNet(o);
      for (const path of net.edge.values()) {
        const flat: number[] = [];
        for (const c of path) flat.push(+((c % this.w) + 0.5).toFixed(1), +(((c / this.w) | 0) + 0.5).toFixed(1));
        out.push(dpSimplify(flat, 1.2));
      }
    }
    this.roadsCache = { ver: this.roadVer, data: out };
    return out;
  }

  private stepBoats() {
    for (const b of this.boats) {
      const p = this.players.get(b.player);
      if (!p?.alive) {
        b.troops = 0;
        continue;
      }
      // Мир с целью десанта — разворачиваем лодку домой: войска вернутся игроку,
      // вместо того чтобы высаживаться на территорию союзника.
      if (!b.returning && b.target > 0 && this.relation(b.player, b.target) === 'allied') {
        b.returning = true;
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

  // суммарный уровень всех заводов игрока — от него растёт цена следующей покупки
  // Сумма уровней всех портов игрока. Цена нового порта считается по ней, а не по
  // числу портов: у заводов и ПВО так и было, а порт был исключением — грейды в
  // цену не входили, и апгрейд до 15-го уровня не удорожал следующий порт вовсе.
  private portLevels(playerId: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === playerId && b.type === 'port') n += b.level;
    return n;
  }
  private factoryLevels(playerId: number): number {
    let n = 0;
    for (const b of this.buildings) if (b.owner === playerId && b.type === 'factory') n += b.level;
    return n;
  }

  // Порт можно ставить на своей прибрежной клетке (рядом вода), без вражеских
  // соседей по суше и без здания в клетке
  private canBuildPort(playerId: number, cell: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    if (this.owners[cell] !== playerId) return false;
    // берег именно ОКЕАНА (shore), а не любой воды: на берегу озера порт был бы
    // построен, но не дал бы ни одного маршрута — деньги в пустоту. Река,
    // впадающая в море, — тоже океан, поэтому речные порты заработают сами.
    if (!this.shore[cell]) return false;
    let enemyAdj = false;
    this.forNeighbors(cell, (n) => {
      if (this.terrain[n] && this.owners[n] !== playerId) enemyAdj = true;
    });
    if (enemyAdj) return false;
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

  // свой штаб, чей купол (радиус HQ_RADIUS) накрывает клетку — ближайший центром.
  // Клик в зону щита в режиме постройки штаба апгрейдит этот щит.
  private hqCovering(playerId: number, cell: number): Building | undefined {
    const cx = cell % this.w, cy = (cell / this.w) | 0, r2 = HQ_RADIUS * HQ_RADIUS;
    let best: Building | undefined, bestD = Infinity;
    for (const b of this.buildings) {
      if (b.type !== 'hq' || b.owner !== playerId) continue;
      const d = (b.cell % this.w - cx) ** 2 + ((b.cell / this.w | 0) - cy) ** 2;
      if (d <= r2 && d < bestD) { bestD = d; best = b; }
    }
    return best;
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
      if (this.buildingNear(shore, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam', 'factory']))
        return 'Слишком близко к другому зданию';
      const cost = portCost(this.portLevels(playerId)); // по сумме уровней, как у заводов и ПВО
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
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
        upQueue: 0,
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
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam', 'factory']))
        return 'Слишком близко к другому зданию';
      const cityN = this.buildings.filter((b) => b.owner === playerId && b.type === 'city').length;
      const cost = cityCost(cityN); // постройка нового — по числу городов
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
        upQueue: 0,
        nextShipTick: 0,
        ships: 0,
        stock: 0,
        reloadTick: 0,
        reloads: [],
      });
      return null;
    }
    if (bt === 'factory') {
      // клик рядом со своим заводом — апгрейд
      const near = this.nearbyOwnType(playerId, cell, 'factory');
      if (near) return this.upgrade(playerId, near.cell);
      if (!this.canBuildAt(playerId, cell)) return 'Стройте в глубине своей земли';
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam', 'factory']))
        return 'Слишком близко к другому зданию';
      const cost = factoryCost(this.factoryLevels(playerId));
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      this.buildings.push({
        id: this.nextBuildingId++,
        owner: playerId,
        cell,
        type: 'factory',
        readyTick: this.tickNo + FACTORY_BUILD_TICKS,
        level: 1,
        fuseTick: 0,
        upStart: 0,
        upEnd: 0,
        upQueue: 0,
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
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam', 'factory']))
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
        upQueue: 0,
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
      if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam', 'factory']))
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
        upQueue: 0,
        nextShipTick: 0,
        ships: 0,
        stock: 0,
        reloadTick: 0,
        reloads: [],
      });
      return null;
    }
    // клик в зону купола своего штаба, который ещё можно улучшить — апгрейд его
    // (а не постройка нового); максимальный/занятый штаб не мешает строить рядом
    const coverHq = this.hqCovering(playerId, cell);
    if (coverHq && coverHq.upEnd === 0 && coverHq.level < MAX_HQ_LEVEL && this.tickNo >= coverHq.readyTick)
      return this.upgrade(playerId, coverHq.cell);
    if (!this.canBuildAt(playerId, cell)) return 'Здесь строить нельзя';
    // штаб нельзя ставить впритык к другому штабу/порту/городу/шахте
    if (this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port', 'silo', 'sam', 'factory']))
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
      upQueue: 0,
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
      const cost = cityUpgradeCost(b.level + 1); // грейд — прогрессивно по уровню города
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      b.level++; // город апгрейдится мгновенно, уровней сколько угодно
      return null;
    }
    if (b.type === 'factory') {
      const cost = factoryCost(this.factoryLevels(playerId)); // по сумме уровней
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      b.level++; // завод апгрейдится мгновенно
      return null;
    }
    // Апгрейды с временем постройки (шахта, ПВО, штаб) можно накликать ВПЕРЁД:
    // повторный клик оплачивает следующий уровень и ставит его в очередь, вместо
    // ответа «Уже улучшается». Оплата считается по БУДУЩЕМУ уровню (с учётом уже
    // стоящих в очереди), иначе можно было бы накликать пачку по цене первого.
    const queued = b.upQueue; // сколько уже оплачено сверх текущего апгрейда
    const inProgress = b.upEnd > 0 ? 1 : 0;
    const pending = inProgress + queued;
    if (pending >= UPGRADE_QUEUE_MAX) return 'Очередь улучшений заполнена';
    if (b.type === 'silo') {
      // шахта: апгрейд по 1млн, идёт 5с; уровень = размер залпа
      if (p.money < SILO_COST) return 'Недостаточно денег';
      p.money -= SILO_COST;
      if (pending > 0) { b.upQueue++; return null; }
      b.upStart = this.tickNo;
      b.upEnd = this.tickNo + SILO_BUILD_TICKS;
      return null;
    }
    if (b.type === 'sam') {
      // ПВО: апгрейд «в общем» по сумме уровней, идёт 5с; уровень = число перехватов.
      // В сумму уровней добавляем всё, что уже стоит в очереди у наших ПВО.
      const cost = samCost(this.samLevels(playerId) + this.pendingUpgrades(playerId, 'sam'));
      if (p.money < cost) return 'Недостаточно денег';
      p.money -= cost;
      if (pending > 0) { b.upQueue++; return null; }
      b.upStart = this.tickNo;
      b.upEnd = this.tickNo + SAM_BUILD_TICKS;
      return null;
    }
    if (b.level + pending >= MAX_HQ_LEVEL) return 'Максимальный уровень';
    const toLevel = b.level + pending + 1;
    const cost = hqUpgradeCost(toLevel);
    if (p.money < cost) return 'Недостаточно денег';
    p.money -= cost;
    if (pending > 0) { b.upQueue++; return null; }
    b.upStart = this.tickNo;
    b.upEnd = this.tickNo + hqUpgradeTicks(toLevel);
    return null;
  }

  /** Сколько апгрейдов данного типа у игрока сейчас в работе и в очереди. */
  private pendingUpgrades(playerId: number, type: BuildingType): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.owner !== playerId || b.type !== type) continue;
      if (b.upEnd > 0) n++;
      n += b.upQueue;
    }
    return n;
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

  // Сила игрока: территория + войска (грубая оценка для решений ботов).
  powerOf(id: number): number {
    const p = this.players.get(id);
    if (!p?.alive) return 0;
    return p.cells + p.troops * 0.5;
  }

  // Текущий лидер (сильнейший живой игрок) — цель «коалиции». Кэш на тик.
  private leaderId = 0;
  private leaderStamp = -1;
  private currentLeader(): number {
    if (this.leaderStamp === this.tickNo) return this.leaderId;
    let best = 0, bestPow = 0;
    for (const pl of this.players.values()) {
      if (!pl.alive || pl.cells <= 0) continue;
      const pw = this.powerOf(pl.id);
      if (pw > bestPow) { bestPow = pw; best = pl.id; }
    }
    this.leaderId = best;
    this.leaderStamp = this.tickNo;
    return best;
  }

  // Выгоден ли боту союз с игроком other? Да, если either (1) other не слабее бота
  // (нет смысла злить сильного), либо (2) бот сейчас в невыгодном положении —
  // воюет с кем-то сильнее себя и ему нужен друг.
  private botWantsAlliance(botId: number, otherId: number): boolean {
    const pb = this.powerOf(botId), po = this.powerOf(otherId);
    if (po >= pb * 0.85) return true;
    for (const foe of this.hostiles.get(botId) ?? [])
      if (this.powerOf(foe) > pb) return true;
    return false;
  }

  // предложить союз владельцу клетки. Бот соглашается только когда ему выгодно;
  // людям — уведомление.
  proposeAlliance(fromId: number, cell: number): { toId: number; auto: boolean; refused?: boolean; name: string } | null {
    const toId = this.owners[cell];
    if (toId <= 0 || toId === fromId) return null;
    const to = this.players.get(toId);
    if (!to?.alive) return null;
    if (this.relation(fromId, toId) === 'allied') return null;
    if (to.bot) {
      if (this.botWantsAlliance(toId, fromId)) {
        this.acceptAlliance(fromId, toId);
        return { toId, auto: true, name: to.name };
      }
      return { toId, auto: false, refused: true, name: to.name }; // боту невыгодно — отказ
    }
    return { toId, auto: false, name: to.name };
  }

  // Объявить войну владельцу клетки (нейтралу): помечаем пару враждебной без
  // необходимости физически атаковать. С союзником нельзя — сначала разорвать союз.
  declareWar(fromId: number, cell: number): boolean {
    const toId = this.owners[cell];
    if (toId <= 0 || toId === fromId) return false;
    const to = this.players.get(toId);
    if (!to?.alive) return false;
    if (this.relation(fromId, toId) !== 'neutral') return false; // уже враги/союзники
    this.markHostile(fromId, toId);
    return true;
  }

  playerName(id: number): string {
    return this.players.get(id)?.name ?? '?';
  }

  // уведомление в ленту владельцу потопленного торгового корабля (кто потопил и где)
  private noticeTradeLost(shipOwner: number, attacker: number, x: number, y: number) {
    if (attacker <= 0 || attacker === shipOwner) return;
    this.relNotices.push({ to: shipOwner, kind: 'trade', name: this.playerName(attacker), x, y });
  }

  acceptAlliance(a: number, b: number) {
    this.setRel(this.hostiles, a, b, false); // союз снимает вражду
    this.setRel(this.allies, a, b, true);
    this.relChanged.add(a).add(b);
    this.recallAttacks(a, b);
  }

  // Союз останавливает уже идущие атаки между сторонами: войска с фронта
  // отзываются и возвращаются владельцу, а не продолжают захват.
  private recallAttacks(a: number, b: number) {
    this.attacks = this.attacks.filter((atk) => {
      const between =
        (atk.player === a && atk.target === b) ||
        (atk.player === b && atk.target === a);

      if (!between) return true;

      const owner = this.players.get(atk.player);

      if (owner?.alive) {
        owner.troops = Math.min(owner.maxTroops, owner.troops + atk.troops);
      }

      return false;
    });
  }

  breakAlliance(a: number, cell: number) {
    const b = this.owners[cell];
    if (b <= 0) return;
    this.breakAllianceId(a, b);
  }

  // Подарок союзнику: золото или войска. Войска не могут превысить лимит
  // получателя, а золото/войска — то, что реально есть у отправителя.
  donate(fromId: number, cell: number, kind: 'gold' | 'troops', amount: number): string | null {
    const from = this.players.get(fromId);
    if (!from?.alive) return 'Нельзя';
    const toId = this.owners[cell];
    if (toId <= 0 || toId === fromId) return 'Неверная цель';
    const to = this.players.get(toId);
    if (!to?.alive) return 'Неверная цель';
    if (this.relation(fromId, toId) !== 'allied') return 'Можно только союзнику';
    amount = Math.floor(amount);
    if (!(amount > 0)) return 'Некорректная сумма';
    if (kind === 'gold') {
      const send = Math.min(amount, Math.floor(from.money));
      if (send <= 0) return 'Недостаточно золота';
      from.money -= send;
      to.money += send;
    } else {
      const cap = Math.max(0, Math.floor(to.maxTroops) - Math.floor(to.troops)); // сколько влезет получателю
      const send = Math.min(amount, Math.floor(from.troops), cap);
      if (send <= 0) return 'Нельзя отправить войска';
      from.troops -= send;
      to.troops = Math.min(to.maxTroops, to.troops + send);
    }
    return null;
  }

  breakAllianceId(a: number, b: number) {
    const wasAllied = this.allies.get(a)?.has(b) ?? false;
    this.setRel(this.allies, a, b, false); // назад в нейтралитет
    this.relChanged.add(a).add(b);
    // уведомляем сторону, с которой расторгли союз (инициатор — a)
    if (wasAllied) this.relNotices.push({ to: b, kind: 'break', name: this.playerName(a) });
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
    // Новый маршрут — это точный поиск по воде, самая дорогая операция в тике.
    // Готовые лежат в кэше (порты статичны), но когда портов много, в один тик
    // может прилететь десяток первых запросов сразу — отсюда пики по 57 мс.
    // Считаем не больше ROUTE_BUDGET новых маршрутов за тик, остальные подождут
    // следующего: судно просто не отправится этим тиком.
    if (this.routeBudget <= 0) return null;
    this.routeBudget--;
    const sx = fromCell % this.w;
    const sy = (fromCell / this.w) | 0;
    const lx = toCell % this.w;
    const ly = (toCell / this.w) | 0;
    let result: { path: number[]; cum: number[]; totalLen: number } | null = null;
    // Порты стоят на суше — судно выходит/входит через океанскую клетку рядом.
    const startW = this.oceanNeighbor(fromCell);
    const goalW = this.oceanNeighbor(toCell);
    // O(1) отсечение недостижимого: разные водные бассейны — маршрута нет, и мы
    // не тратим обход всей карты (как ComponentCheckTransformer в OpenFront)
    if (startW >= 0 && goalW >= 0 && this.sameWaterBody(startW, goalW)) {
      // 1) грубый коридор (сетка оптимистична — «вода побеждает»)
      const startC = this.nearestWaterCoarse(startW % this.w, (startW / this.w) | 0);
      const goalC = this.nearestWaterCoarse(goalW % this.w, (goalW / this.w) | 0);
      const coarse = startC >= 0 && goalC >= 0 ? this.waterPath(startC, goalC) : null;
      // 2) точный путь по воде внутри коридора; если коридор оказался тупиком
      // (правило «вода побеждает» могло его наврать) — ищем без ограничения
      let cells = coarse ? this.waterPathCorridor(startW, goalW, coarse) : null;
      if (!cells) cells = this.waterPathCorridor(startW, goalW, null);
      if (cells && cells.length) {
        // 3) спрямление: из тысяч клеток остаётся десяток точек, и КАЖДЫЙ
        // отрезок между ними проверен как полностью водный
        const keep = smoothWaterPath(this.terrain, this.w, this.h, cells);
        const path: number[] = [sx + 0.5, sy + 0.5]; // от самого порта
        for (const c of keep) path.push((c % this.w) + 0.5, ((c / this.w) | 0) + 0.5);
        path.push(lx + 0.5, ly + 0.5); // и до самого порта-получателя
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
        destCell: dest.cell,
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
      // порт-назначение уничтожен, стал НАШИМ (сам с собой не торгуют — напр.
      // мы захватили страну-партнёра) ИЛИ мы объявили войну его владельцу —
      // корабль тонет, освобождая место под новый маршрут
      const dest = this.buildings.find((b) => b.cell === s.destCell && b.type === 'port');
      if (!dest || dest.owner === s.owner || this.relation(s.owner, dest.owner) === 'hostile') {
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
    // по союзнику ракету не пускаем (в т.ч. бот не бьёт своего союзника-человека)
    const tOwner = this.owners[cell];
    if (tOwner > 0 && tOwner !== playerId && this.relation(playerId, tOwner) === 'allied') return 'Союзник';
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

  // Запуск роя дронов «Мопед» по стране-владельцу клетки: вылетают со ВСЕХ
  // достроенных ракетных шахт (распределяются поровну), стоят DRONE_COST.
  launchDrones(playerId: number, cell: number): string | null {
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return 'Нельзя';
    if (cell < 0 || cell >= this.cells) return 'Неверная цель';
    const target = this.owners[cell];
    if (target <= 0 || target === playerId) return 'Неверная цель';
    if (this.relation(playerId, target) === 'allied') return 'Союзник';
    const silos = this.buildings.filter(
      (b) => b.type === 'silo' && b.owner === playerId && this.tickNo >= b.readyTick
    );
    if (!silos.length) return 'Нужна ракетная шахта';
    if (p.money < DRONE_COST) return 'Недостаточно денег';
    p.money -= DRONE_COST;
    this.markHostile(playerId, target); // запуск роя = объявление войны цели
    const tcells = this.playerCells(target);
    // размер роя ∝ территории цели: минимум DRONE_COUNT, +1 дрон за DRONE_CELLS_PER
    // клеток, но не больше DRONE_COUNT_MAX (мелкую страну — базовый рой, континент —
    // сотни дронов).
    const count = Math.max(
      DRONE_COUNT,
      Math.min(DRONE_COUNT_MAX, Math.round(tcells.length / DRONE_CELLS_PER))
    );
    for (let i = 0; i < count; i++) {
      const silo = silos[i % silos.length];
      const sx = (silo.cell % this.w) + 0.5, sy = ((silo.cell / this.w) | 0) + 0.5;
      const wc = tcells.length ? tcells[(Math.random() * tcells.length) | 0] : cell;
      this.drones.push({
        id: this.nextDroneId++,
        owner: playerId,
        target,
        x: sx,
        y: sy,
        wx: (wc % this.w) + 0.5,
        wy: ((wc / this.w) | 0) + 0.5,
        a: 0,
        fireAt: this.tickNo + ((Math.random() * DRONE_FIRE_COOLDOWN) | 0),
        bombs: DRONE_BOMBS,
        doomed: false,
        done: false,
      });
    }
    return null;
  }

  // Взрыв бомбы дрона в его ТЕКУЩЕЙ точке: −5% текущей армии цели + зачистка
  // территории цели в радиусе DRONE_CLEAR_R + вспышка. Один и тот же эффект и при
  // обычном сбросе, и при падении дрона (сбит ПВО или кончился боезапас).
  droneBomb(d: Drone) {
    const tp = this.players.get(d.target);
    if (tp?.alive) tp.troops = Math.max(0, tp.troops * (1 - DRONE_DAMAGE_FRAC));
    const bcx = d.x | 0, bcy = d.y | 0, R = DRONE_CLEAR_R, R2 = R * R;
    for (let ey = -R; ey <= R; ey++) {
      const y = bcy + ey;
      if (y < 0 || y >= this.h) continue;
      for (let ex = -R; ex <= R; ex++) {
        if (ex * ex + ey * ey > R2) continue;
        const x = bcx + ex;
        if (x < 0 || x >= this.w) continue;
        const n = y * this.w + x;
        if (this.terrain[n] && this.owners[n] === d.target) this.setOwner(n, 0);
      }
    }
    this.droneBlasts.push(+d.x.toFixed(1), +d.y.toFixed(1));
  }

  // Полёт дронов: хаотичное блуждание над территорией цели, сброс бомб (−5%
  // текущей армии за взрыв) и сбитие вражеским ПВО (расходует заряд ПВО).
  private stepDrones() {
    if (!this.drones.length) return;
    const w = this.w;
    const samR2 = SAM_RANGE * SAM_RANGE;
    let dead = false;
    // Новая точка полёта: случайная ещё ЗАНЯТАЯ клетка цели, ПОДАЛЬШЕ от текущей
    // позиции (≥ SPREAD) — чтобы дроны разлетались, а не кучковались в одном месте.
    const SPREAD = DRONE_CLEAR_R * 2.5; // минимальный разлёт между точками сброса
    const pickSpreadCell = (target: number, fx: number, fy: number): number => {
      const tc = this.playerCells(target);
      if (!tc.length) return -1;
      let fallback = -1;
      for (let k = 0; k < 16; k++) {
        const c = tc[(Math.random() * tc.length) | 0];
        if (this.owners[c] !== target) continue;
        fallback = c;
        const cx = c % w, cy = (c / w) | 0;
        if ((cx - fx) ** 2 + (cy - fy) ** 2 >= SPREAD * SPREAD) return c; // достаточно далеко
      }
      return fallback; // не нашли дальней — берём хоть какую-то занятую
    };
    for (const d of this.drones) {
      if (d.done) { dead = true; continue; } // сбит ракетой ПВО (в stepBullets)
      const tp = this.players.get(d.target);
      if (!tp?.alive || tp.cells <= 0) { d.done = true; dead = true; continue; }
      // Заключили союз с целью — рой немедленно исчезает, а не продолжает летать и
      // бомбить союзника (как отзываются наземные атаки и десанты, см. §8 в
      // docs/balance-openfront.md). Деньги за запуск не возвращаются: рой уже вылетел.
      if (this.relation(d.owner, d.target) === 'allied') { d.done = true; dead = true; continue; }
      // Каждый дрон летит к СВОЕЙ точке (разбросаны по территории) и сбрасывает
      // бомбу ПРИ ПРИЛЁТЕ, после чего берёт новую дальнюю точку → рой разлетается,
      // а не бьёт кучей в одно место.
      const dx = d.wx - d.x, dy = d.wy - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= 2) {
        d.a = Math.atan2(dy, dx);
        d.x += (dx / dist) * DRONE_SPEED;
        d.y += (dy / dist) * DRONE_SPEED;
      } else {
        // прилетел к своей точке. Ждём перезарядку (кружим над ней), затем СБРАСЫВАЕМ
        // бомбу и берём новую дальнюю точку — так рой разлетается и гарантированно
        // тратит боезапас (не зависает вечно).
        if (this.tickNo >= d.fireAt) {
          this.droneBomb(d); // взрыв: −5% армии + зачистка территории + вспышка
          if (--d.bombs <= 0) { d.done = true; dead = true; continue; } // боезапас кончился — падает и взрывается (последняя бомба = взрыв при падении)
          const nc = pickSpreadCell(d.target, d.x, d.y);
          if (nc < 0) { d.done = true; dead = true; continue; } // территории не осталось — падает
          d.wx = (nc % w) + 0.5;
          d.wy = ((nc / w) | 0) + 0.5;
          d.fireAt = this.tickNo + DRONE_FIRE_COOLDOWN;
        } else {
          // ждём перезарядку — медленно кружим над точкой (чтобы не зависать пикселем)
          d.a += 0.25;
          d.x += Math.cos(d.a) * 0.35;
          d.y += Math.sin(d.a) * 0.35;
        }
      }
      // ПВО цели пускает по дрону самонаводящуюся ракету (тратит заряд). Дрон не
      // гибнет мгновенно — ракета летит и догоняет его (см. stepBullets).
      if (!d.doomed) {
        for (const b of this.buildings) {
          if (b.type !== 'sam' || b.owner === d.owner || this.tickNo < b.readyTick) continue;
          if (b.reloads.length >= b.level) continue; // нет свободных зарядов
          const sx = (b.cell % w) + 0.5, sy = ((b.cell / w) | 0) + 0.5;
          if ((sx - d.x) ** 2 + (sy - d.y) ** 2 <= samR2) {
            b.reloads.push(this.tickNo + SAM_RELOAD_TICKS);
            d.doomed = true;
            this.bullets.push({
              id: this.nextBulletId++,
              owner: b.owner,
              fromId: -1, // источник — ПВО, не корабль
              x: sx,
              y: sy,
              targetId: d.id,
              targetKind: 'drone',
              dmg: 1,
            });
            break;
          }
        }
      }
    }
    if (dead) this.drones = this.drones.filter((d) => !d.done);
  }

  dronesPub(): { x: number; y: number; a: number; owner: number }[] {
    return this.drones.map((d) => ({ x: +d.x.toFixed(1), y: +d.y.toFixed(1), a: +d.a.toFixed(2), owner: d.owner }));
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
        this.detonate(m.targetCell, spec?.radius ?? HQ_EXPLODE_RADIUS * 2, spec?.armyFrac ?? 0.25, m.owner);
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
      // порт/город/завод/шахта/ПВО: при захвате клетки переходят захватчику (нейтраль/взрыв — снос)
      if (b.type === 'port' || b.type === 'city' || b.type === 'factory' || b.type === 'silo' || b.type === 'sam') {
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
            b.upQueue = 0; // очередь улучшений прежнего хозяина не наследуется
          } else {
            remove.add(b);
          }
        } else if ((b.type === 'silo' || b.type === 'sam') && b.upEnd > 0 && this.tickNo >= b.upEnd) {
          b.level++; // апгрейд завершён (силос — залп, ПВО — число перехватов)
          b.upStart = 0;
          b.upEnd = 0;
          if (b.upQueue > 0) {
            // следующий уровень из очереди — он уже оплачен при клике
            b.upQueue--;
            b.upStart = this.tickNo;
            b.upEnd = this.tickNo + (b.type === 'silo' ? SILO_BUILD_TICKS : SAM_BUILD_TICKS);
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
  private detonate(cell: number, R: number, armyFrac: number, attacker = 0) {
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
      // удар по чужой территории делает жертву врагом (как и наземная атака)
      if (attacker > 0) this.markHostile(attacker, owner);
    }
    for (const n of inBlast) this.setOwner(n, 0);
    // ядерный взрыв топит любые суда в радиусе — боевые, торговые и десант
    const bx = cx + 0.5, by = cy + 0.5;
    let sunkWar = false, sunkTrade = false, sunkBoat = false;
    for (const s of this.warships) if ((s.x - bx) ** 2 + (s.y - by) ** 2 <= R2) { s.hp = 0; sunkWar = true; }
    for (const s of this.tradeShips) if ((s.x - bx) ** 2 + (s.y - by) ** 2 <= R2) { s.done = true; sunkTrade = true; this.noticeTradeLost(s.owner, attacker, s.x, s.y); }
    for (const b of this.boats) if ((b.x - bx) ** 2 + (b.y - by) ** 2 <= R2) { b.troops = 0; sunkBoat = true; }
    if (sunkWar) this.warships = this.warships.filter((s) => s.hp > 0);
    if (sunkTrade) this.tradeShips = this.tradeShips.filter((s) => !s.done);
    if (sunkBoat) this.boats = this.boats.filter((b) => b.troops >= 1);
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
    this.routeBudget = ROUTE_BUDGET;
    // здание завершилось на этом тике — пересобрать поле укреплений
    for (const b of this.buildings) if (b.readyTick === this.tickNo) this.fortDirty = true;
    this.checkBuildings(); // захват/фитиль/взрыв щитов
    if (this.fortDirty) this.rebuildFort();
    // инвалидация дорожной сети при изменении набора заводов/городов/портов
    // (постройка/захват/снос/готовность) — подпись меняется → пересчёт кэша
    let rsig = 0;
    for (const b of this.buildings)
      if (b.type === 'factory' || b.type === 'city' || b.type === 'port')
        rsig = (rsig * 131 + b.cell * 7 + b.owner * 3 + (this.tickNo >= b.readyTick ? 1 : 0)) | 0;
    if (rsig !== this.roadSig) { this.roadSig = rsig; this.roadVer++; }
    // суммарная прибавка к лимиту войск от достроенных городов (по игрокам)
    const cityBonus = new Map<number, number>();
    // заводы: число и суммарный % ускорения регена по игрокам (деньги — через грузовики)
    const facN = new Map<number, number>();
    const facPct = new Map<number, number>();
    const facGold = new Map<number, number>(); // доход заводов за тик
    for (const b of this.buildings) {
      if (this.tickNo < b.readyTick) continue;
      if (b.type === 'city') {
        cityBonus.set(b.owner, (cityBonus.get(b.owner) || 0) + cityTroopBonus(b.level));
      } else if (b.type === 'factory') {
        facN.set(b.owner, (facN.get(b.owner) || 0) + 1);
        facPct.set(b.owner, (facPct.get(b.owner) || 0) + factoryBoostPct(b.level));
        // Доход завода за тик. Функция factoryIncome существовала с самого начала,
        // но нигде не вызывалась: заводы «добывали золото» только на словах, а на
        // деле давали лишь ускорение регена. Из-за этого у экономики был всего один
        // реальный источник — торговля, а она требует НЕ ВРАЖДЕБНОГО партнёра с
        // портом, которых у воюющего бота почти нет.
        facGold.set(b.owner, (facGold.get(b.owner) || 0) + factoryIncome(b.level));
      }
    }
    // войска, вложенные каждым игроком в его активные атаки (см. COMMITTED_COUNTS)
    const committed = new Map<number, number>();
    for (const a of this.attacks) {
      if (a.troops >= 1) committed.set(a.player, (committed.get(a.player) || 0) + a.troops);
    }
    for (const p of this.players.values()) {
      if (!p.alive || !p.spawned) continue;
      // ранний фактор: 1 на старте → 0 через 45с
      const early = Math.max(0, 1 - (this.tickNo - p.spawnTick) / 450);
      // в начале даём запас потолка, чтобы армия росла сразу (а не только
      // территория); к 45с запас исчезает, но реальный потолок уже больше.
      // cellFactor — сублинейный вклад территории (CAP_EXP): большая империя
      // держит меньше войск на клетку, то есть её оборона тоньше (см. P1 в
      // docs/balance-openfront.md). Города обходят этот мягкий потолок флэтом.
      const normalMax = (150 + cellFactor(p.cells) * 12) * p.maxMul + early * 1500 + (cityBonus.get(p.id) || 0);
      // «Бесконечная армия» (настройка лобби): потолок 100млн; армия выставляется
      // сразу в максимум ниже (мгновенно, не постепенно)
      p.maxTroops = this.infArmy && !p.bot ? 100_000_000 : normalMax;
      // Прирост зависит от ТЕРРИТОРИИ (потолка), а не от текущего размера армии.
      // Иначе «богатый» с большой армией восполняет потраченное быстрее «бедного»
      // (рост ∝ армии — снежный ком). Теперь два игрока с равной территорией
      // восполняют войска одинаково быстро, независимо от того, сколько у них
      // сейчас войск — у выбитого/обороняющегося есть реальный шанс отыграться.
      const base = Math.max(0.5, normalMax * 0.004 * p.growthMul);
      // ВСЯ сила игрока = гарнизон + войска, вложенные в его активные атаки. Пока
      // атака жива, эти войска никуда не делись, поэтому и потолок для прироста
      // считается по ним: слив армию в наступление, агрессор НЕ получает пустой
      // гарнизон и не запускает догоняющий буст (см. COMMITTED_COUNTS).
      const inAttacks = (committed.get(p.id) || 0) * COMMITTED_COUNTS;
      const force = p.troops + inAttacks;
      // логистическое торможение: до 70% максимума — полный рост, дальше плавно
      const frac = p.maxTroops > 0 ? force / p.maxTroops : 1;
      const taper =
        frac <= GROWTH_SLOW_FROM
          ? 1
          : Math.max(0.03, 1 - ((frac - GROWTH_SLOW_FROM) / (1 - GROWTH_SLOW_FROM)) * 0.97);
      // догоняющий буст: чем сильнее выбита армия, тем быстрее восполнение.
      // Ослаблен (макс ×1.8 при frac 0), чтобы агрессор, вывалив всю армию в
      // атаку, НЕ восполнял её мгновенно и не мог бесконечно слать волны.
      const boost = 1 + 0.8 * Math.max(0, 1 - frac / 0.55);
      // ОБОРОННЫЙ буст: если игрок только что терял клетки (его атакуют), он
      // пополняет войска заметно быстрее — успевает нарастить гарнизон и отбиться.
      // Помогает именно защищающемуся (агрессор клетки не теряет — буста не имеет).
      const defBoost = this.tickNo - p.hurtTick < DEFEND_BOOST_TICKS ? DEFEND_BOOST : 1;
      // завод: ускоряет реген в своей зоне — эффект на первые 30к войск/завод
      // (для больших армий буст слабее), базово +10%, +3% за каждые 10 уровней
      let facBoost = 1;
      const fn = facN.get(p.id) || 0;
      if (fn > 0 && p.troops > 0) {
        const covered = Math.min(p.troops, FACTORY_COVER * fn);
        const avgPct = (facPct.get(p.id) || 0) / fn;
        facBoost = 1 + avgPct * (covered / p.troops);
      }
      // ранний буст: рост вдвое быстрее + флэт ~+200/с на старте, затухает.
      // 0.75 — общий темп пополнения армии снижен (армии набираются медленнее)
      const growth = (base * (1 + early) + early * 20) * taper * boost * facBoost * defBoost * 0.75;
      // потолок — на ВСЮ силу: иначе, вывалив половину армии в атаку, можно было
      // бы отрастить гарнизон снова до потолка и получить суммарно больше предела
      const room = Math.max(0, p.maxTroops - force);
      p.troops = Math.min(p.maxTroops, p.troops + Math.min(growth, room));
      if (this.infArmy && !p.bot) p.troops = p.maxTroops; // «Бесконечная армия» — сразу максимум (100млн)
      // пассивный доход денег — на копейки, от размера территории (заводы — через грузовики)
      p.money += 0.5 + p.cells * 0.08 + (facGold.get(p.id) || 0);
      if (this.infMoney && !p.bot) p.money = 10_000_000_000; // «Бесконечные деньги» — фиксировано 10млрд
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
    this.stepWarships();
    this.stepBullets();
    this.spawnTrucks();
    this.stepTrucks();
    this.reloadSilos();
    this.stepMissiles();
    this.stepDrones();
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
      const k = this.neighbors4(c, this.nbuf);
      for (let i = 0; i < k; i++) {
        const n = this.nbuf[i];
        if (this.terrain[n] && this.owners[n] === 0) return true;
      }
    }
    return false;
  }

  private buildFrontier(a: Attack) {
    a.frontier.clear();
    // клетки цели, граничащие с нами = соседи-цели у наших клеток
    const buf = this.nbuf;
    for (const c of this.playerCells(a.player)) {
      if (this.owners[c] !== a.player) continue; // протухшая запись
      const k = this.neighbors4(c, buf);
      for (let i = 0; i < k; i++) {
        const n = buf[i];
        if (this.terrain[n] && this.owners[n] === a.target) a.frontier.add(n);
      }
    }
  }

  // Волновой захват: фронт поддерживается инкрементально, клетки с большим
  // числом своих соседей берутся первыми — дыры зарастают, граница ровная
  private stepAttack(a: Attack) {
    const nb = this.nbuf;
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
    // Заключили мир, пока наступление шло: войска отзываются и возвращаются в
    // баланс, а не продолжают захватывать союзника. Так же сделано в OpenFront —
    // AttackExecution при появлении союза вызывает retreat().
    if (a.target > 0 && this.relation(a.player, a.target) === 'allied') {
      this.refund(a, attacker);
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
    // Корзины фронта: сначала по числу своих соседей (4 — дыры, потом 3, 2, 1),
    // внутри — по местности (песок → трава → камень/снег, TERRAIN_TIER). Так
    // дыры зарастают первыми, а наступление обтекает горы вместо лба в гору.
    const buckets: number[][] = [];
    for (let i = 0; i < 5 * TERRAIN_TIERS; i++) buckets.push([]);
    for (const c of a.frontier) {
      if (this.owners[c] !== a.target) {
        a.frontier.delete(c); // клетку уже кто-то занял
        continue;
      }
      let own = 0;
      const kn = this.neighbors4(c, nb);
      for (let i = 0; i < kn; i++) if (this.owners[nb[i]] === a.player) own++;
      if (own === 0) {
        a.frontier.delete(c); // потеряли контакт с этой клеткой
        continue;
      }
      buckets[own * TERRAIN_TIERS + TERRAIN_TIER[this.terrain[c]]].push(c);
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
    let ratioMul = 1; // множитель цены от соотношения сил
    let costDensity = 0; // плотность для ЦЕНЫ (с полом обороны)
    if (enemy) {
      density = enemy.cells > 0 ? enemy.troops / enemy.cells : 0;
      // пол обороны: территория стоит войск, даже если гарнизон выбит начисто —
      // считаем не ниже DEF_FLOOR от плотности при армии у потолка. Потери самого
      // защитника при этом остаются равны РЕАЛЬНОЙ плотности (больше, чем есть,
      // он потерять не может) — пол удорожает захват, а не выкачивает призрачные
      // войска. Это наш аналог флэта mag из OpenFront.
      const fullDensity = enemy.cells > 0 ? enemy.maxTroops / enemy.cells : 0;
      costDensity = Math.max(density, fullDensity * DEF_FLOOR);
      if (enemy.troops > 0) {
        // потолок перевеса снижен (6→3.5→WAVE_SCALE_MAX): подавляющий агрессор
        // больше не прорезает оборону молниеносно — у защиты есть время
        // нарастить войска. Снижен ещё раз, т.к. перевес теперь влияет и на цену.
        waveScale = Math.min(WAVE_SCALE_MAX, Math.max(0.2, a.troops / enemy.troops));
        // Перевес влияет и на ЦЕНУ клетки: вложенная атака берёт клетки до 40%
        // дешевле, атака «каплей» — до вдвое дороже. Раньше цена от размера
        // атаки не зависела вообще, и спам мелкими волнами был оптимален.
        ratioMul = Math.min(RATIO_COST_MAX, Math.max(RATIO_COST_MIN, enemy.troops / a.troops));
      }
      baseCost = (1 + 2 * costDensity) * ratioMul;
    }
    // остаток меньше даже самой дешёвой клетки (песок) — наступление выдохлось
    const minCost = baseCost * TERRAIN_DEF_MIN;
    if (a.troops < minCost) {
      this.refund(a, attacker);
      return;
    }
    let quota = Math.max(1, Math.ceil(a.frontier.size * WAVE_SPEED * waveScale));
    outer: for (let own = 4; own >= 1; own--) {
      for (let tier = 0; tier < TERRAIN_TIERS; tier++) {
        const list = buckets[own * TERRAIN_TIERS + tier];
        while (list.length && quota > 0) {
          const i = (Math.random() * list.length) | 0;
          const c = list[i];
          const t = this.terrain[c];
          // укреплена ли клетка штабом её владельца; сопротивление по уровню:
          // 1 ур. — 1:5, 2 ур. — 1:7, 3 ур. — 1:10
          const fortified = enemy && this.fortField[c] === a.target;
          const fl = this.fortLevel[c];
          const mul = fl >= 3 ? 10 : fl === 2 ? 7 : 5;
          // местность множит цену: камень/снег дороже, песок дешевле
          const cellCost =
            (fortified ? (1 + mul * costDensity) * ratioMul : baseCost) * TERRAIN_DEF[t];
          if (a.troops < cellCost) {
            // не по карману именно эта клетка — пропускаем её в этом тике
            if (a.troops < minCost) break outer; // не хватает уже ни на что
            list.splice(i, 1);
            continue;
          }
          list[i] = list[list.length - 1];
          list.pop();
          a.frontier.delete(c);
          this.setOwner(c, a.player);
          a.troops -= cellCost;
          if (enemy) {
            enemy.troops = Math.max(0, enemy.troops - density);
            // Уведомление «вас захватывают» — только на НАЧАЛО натиска (когда клетки
            // не терялись дольше ATTACK_NOTICE_GAP), иначе оно летело бы каждый тик.
            if (this.tickNo - enemy.hurtTick > ATTACK_NOTICE_GAP) {
              this.relNotices.push({
                to: enemy.id,
                kind: 'attacked',
                name: this.playerName(a.player),
                x: c % this.w,
                y: (c / this.w) | 0,
              });
            }
            enemy.hurtTick = this.tickNo; // защищающийся под атакой — включаем оборонный буст роста
          }
          // расход квоты (темп): горы тормозят, зона штаба тормозит втрое —
          // укрепление даёт защите ВРЕМЯ, а не только берёт с атаки налог
          quota -= (fortified ? FORT_SLOW : 1) * TERRAIN_SPEED[t];
          // расширяем фронт на соседей захваченной клетки
          const kn2 = this.neighbors4(c, nb);
          for (let i = 0; i < kn2; i++) {
            const n = nb[i];
            if (this.terrain[n] && this.owners[n] === a.target) a.frontier.add(n);
          }
        }
        if (quota <= 0) break outer;
      }
    }
  }

  // Флот бота: перехват десантов, прикрытие берега/торговых путей, постройка кораблей.
  // Патруль у своего порта сам стреляет по проходящим вражеским судам (торговля,
  // десанты) — это и есть «перекрытие пролива/торгового пути» у своих берегов.
  private botFleet(p: Player) {
    const ports = this.buildings.filter(
      (b) => b.owner === p.id && b.type === 'port' && this.tickNo >= b.readyTick
    );
    if (!ports.length) return; // без порта корабль не выпустить
    const myWar = this.warships.filter((s) => s.owner === p.id);
    // вражеские десанты, идущие к нам (враждебные) — цель для перехвата
    const threats = this.boats.filter(
      (b) =>
        b.player !== p.id &&
        this.relation(p.id, b.player) === 'hostile' &&
        (b.target === p.id || this.owners[b.landCell] === p.id)
    );
    // перехват: направляем корабли на ближайший десант, но только если ни один
    // ещё не прикрывает его (иначе зря пересчитываем маршрут каждый тик)
    if (threats.length && myWar.length) {
      const t = threats[0];
      const covered = myWar.some((s) => (s.x - t.x) ** 2 + (s.y - t.y) ** 2 < WARSHIP_RANGE * WARSHIP_RANGE);
      if (!covered) {
        const cell = (Math.round(t.y) | 0) * this.w + (Math.round(t.x) | 0);
        this.moveWarships(p.id, myWar.map((s) => s.id), cell);
      }
    }
    // постройка нового корабля (не больше 3), если хватает денег
    // Флот — роскошь: покупаем корабли только когда базовая оборона уже стоит
    // (ПВО и ракетная шахта) и из свободных денег, а не мимо всякого бюджета.
    // 37 кораблей за партию — это порядка 19 млн, ровно тот масштаб, которого боту
    // не хватало на ПВО (1.5 млн) и стратегический удар.
    const hasBase =
      this.buildings.some((b) => b.owner === p.id && b.type === 'sam') &&
      this.buildings.some((b) => b.owner === p.id && b.type === 'silo');
    if (hasBase && myWar.length < 3 && p.money >= warshipCost(myWar.length) + BOT_CHEST_BASE) {
      let zone = -1;
      if (threats.length) {
        const t = threats[0];
        zone = (Math.round(t.y) | 0) * this.w + (Math.round(t.x) | 0);
      } else {
        // иначе — патруль у своего порта (прикрытие подходов с моря и торговли)
        const port = ports[(Math.random() * ports.length) | 0].cell;
        const [wx, wy] = this.nearestWaterFine(port % this.w, (port / this.w) | 0, 14);
        if (!this.terrain[wy * this.w + wx]) zone = wy * this.w + wx;
      }
      if (zone >= 0) this.launchWarship(p.id, zone);
    }
    // Наступательность: если угроз нет и корабли есть — иногда двигаем их к
    // вражескому берегу/порту (блокада торговли и десантов), а не держим у себя
    if (!threats.length && myWar.length && Math.random() < 0.4) {
      // цель: порт враждебного игрока или его прибрежная клетка
      const foePorts = this.buildings.filter(
        (b) => b.type === 'port' && b.owner !== p.id && this.relation(p.id, b.owner) === 'hostile' && this.tickNo >= b.readyTick
      );
      let zoneCell = -1;
      if (foePorts.length) {
        const fp = foePorts[(Math.random() * foePorts.length) | 0].cell;
        const [wx, wy] = this.nearestWaterFine(fp % this.w, (fp / this.w) | 0, 20);
        if (!this.terrain[wy * this.w + wx]) zoneCell = wy * this.w + wx;
      } else {
        // враждебных портов нет — стережём ближайшее к нам вражеское судно/трейд
        const foeShip = this.tradeShips.find((s) => s.owner !== p.id && this.relation(p.id, s.owner) === 'hostile');
        if (foeShip) zoneCell = (Math.round(foeShip.y) | 0) * this.w + (Math.round(foeShip.x) | 0);
      }
      // не гоняем, если уже кто-то рядом с этой зоной
      if (zoneCell >= 0) {
        const zx = zoneCell % this.w, zy = (zoneCell / this.w) | 0;
        const covered = myWar.some((s) => (s.x - zx) ** 2 + (s.y - zy) ** 2 < (WARSHIP_RANGE * 0.7) ** 2);
        if (!covered) this.moveWarships(p.id, myWar.map((s) => s.id), zoneCell);
      }
    }
  }

  // Морской десант бота: найти прибрежную клетку врага (в т.ч. на другом острове)
  // и высадиться туда (launchInvasion сам проверит морской путь).
  private botSeaInvade(p: Player) {
    if (this.boats.filter((b) => b.player === p.id).length >= 2) return; // не спамим
    const foes = [...this.players.values()].filter(
      (x) => x.id !== p.id && x.alive && x.cells > 0 && this.relation(p.id, x.id) !== 'allied'
    );
    if (!foes.length) return;
    const foe = foes[(Math.random() * foes.length) | 0];
    const fcells = this.playerCells(foe.id);
    if (!fcells.length) return;
    for (let tries = 0; tries < 24; tries++) {
      const c = fcells[(Math.random() * fcells.length) | 0];
      if (this.owners[c] !== foe.id) continue;
      let coastal = false;
      this.forNeighbors(c, (n) => { if (!this.terrain[n]) coastal = true; });
      if (coastal) { this.launchInvasion(p.id, c, 0.4); return; }
    }
  }

  // Колонизация ботом: находит НЕЙТРАЛЬНУЮ прибрежную сушу на ДРУГОМ материке
  // (пустой остров) неподалёку и высаживает туда десант — чтобы пустые острова
  // не простаивали. Свой материк осваивается по суше, его не трогаем.
  private botColonize(p: Player) {
    if (this.boats.filter((b) => b.player === p.id).length >= 2) return;
    const my = this.playerCells(p.id);
    if (!my.length) return;
    const home = my[(Math.random() * my.length) | 0];
    const hx = home % this.w, hy = (home / this.w) | 0;
    const myLand = this.landId[home];
    let best = -1, bestD = Infinity;
    for (let tries = 0; tries < 60; tries++) {
      const rx = hx + ((Math.random() * 220) | 0) - 110;
      const ry = hy + ((Math.random() * 220) | 0) - 110;
      if (rx < 0 || ry < 0 || rx >= this.w || ry >= this.h) continue;
      const c = ry * this.w + rx;
      if (!this.terrain[c] || this.owners[c] !== 0) continue; // нужна свободная суша
      if (this.landId[c] === myLand) continue; // тот же материк — займём посуху
      let coastal = false;
      this.forNeighbors(c, (n) => { if (!this.terrain[n]) coastal = true; });
      if (!coastal) continue;
      const d = (rx - hx) ** 2 + (ry - hy) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best >= 0) this.launchInvasion(p.id, best, 0.35);
  }

  // Клетка для новой постройки бота, максимально ДАЛЁКАЯ от уже существующих своих
  // зданий (farthest-point): постройки расходятся по всей территории, а не кучкуются
  // в одном углу. Так города застраивают всю землю, ПВО прикрывают её целиком, а
  // дорожная сеть (заводы → грузовики) растягивается на всю страну. -1 если некуда.
  // Клетка под ОБОРОННУЮ постройку — рядом с угрожаемой границей. Штаб обороны
  // имеет смысл только там, где будет прорыв; spreadBuildCell (farthest-point)
  // отправлял его в глубокий тыл, где его зона не пересекалась с фронтом вообще.
  private borderBuildCell(playerId: number, near: number, maxR = 40): number {
    const nx = near % this.w;
    const ny = (near / this.w) | 0;
    const EX: BuildingType[] = ['hq', 'city', 'port', 'silo', 'sam', 'factory'];
    for (let r = 2; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const y = ny + dy;
        if (y < 0 || y >= this.h) continue;
        const stepX = Math.abs(dy) === r ? 1 : 2 * r; // только кромка кольца
        for (let dx = -r; dx <= r; dx += stepX) {
          const x = nx + dx;
          if (x < 0 || x >= this.w) continue;
          const c = y * this.w + x;
          if (this.owners[c] !== playerId) continue;
          if (!this.canBuildAt(playerId, c)) continue;
          if (this.buildingNear(c, PORT_RADIUS, EX)) continue;
          return c;
        }
      }
    }
    return -1;
  }

  private spreadBuildCell(playerId: number, cells: number[], step: number, minGap = PORT_RADIUS): number {
    const own = this.buildings.filter((b) => b.owner === playerId);
    const w = this.w;
    const EX: BuildingType[] = ['hq', 'city', 'port', 'silo', 'sam', 'factory'];
    let best = -1;
    let bestD = -1;
    for (let i = (Math.random() * step) | 0; i < cells.length; i += step) {
      const c = cells[i];
      if (this.owners[c] !== playerId) continue;
      if (!this.canBuildAt(playerId, c)) continue;
      if (this.buildingNear(c, minGap, EX)) continue;
      const cx = c % w;
      const cy = (c / w) | 0;
      let dmin = Infinity;
      for (const b of own) {
        const bx = b.cell % w;
        const by = (b.cell / w) | 0;
        const d = (bx - cx) ** 2 + (by - cy) ** 2;
        if (d < dmin) dmin = d;
      }
      if (dmin > bestD) {
        bestD = dmin;
        best = c;
      }
    }
    return best;
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

    // Идёт ли наше наступление и есть ли готовая шахта — от этого зависят и
    // боевая касса, и запуск роя дронов.
    const atWar = this.attacks.some((a) => a.player === p.id && a.troops >= 1 && a.target > 0);
    const hasSilo = this.buildings.some(
      (b) => b.owner === p.id && b.type === 'silo' && this.tickNo >= b.readyTick
    );
    const aggroSam = DIFFICULTY[this.difficulty].aggro; // на высокой сложности ПВО больше
    // Страны строят города (рост лимита войск) и штабы-щиты (оборона) — как игрок.
    // Ограничиваем число, чтобы не спамить, и гейтим деньгами.
    if (p.strong) {
      // === Постройки и экономика: модель OpenFront (NationStructureBehavior) ===
      // Количества — ДОЛЯ ОТ ЧИСЛА ГОРОДОВ (их ratioPerCity), а не фиксированные
      // потолки. Раньше: заводов максимум 5, порт и шахта по одной, ПВО до 12
      // уровня и не больше 20, штабов 2 — в поздней игре бот упирался во всё это и
      // сливал золото в города, единственное, что росло без ограничений.
      const countType = (t: BuildingType) =>
        this.buildings.filter((b) => b.owner === p.id && b.type === t).length;
      const mine = this.buildings.filter((b) => b.owner === p.id);
      const ready = (b: Building) => this.tickNo >= b.readyTick && b.upEnd === 0;
      const lowestOf = (t: BuildingType, maxLvl = Infinity) =>
        mine
          .filter((b) => b.type === t && ready(b) && b.level < maxLvl)
          .sort((a, b) => a.level - b.level)[0];
      const EX: BuildingType[] = ['hq', 'city', 'port', 'silo', 'sam', 'factory'];
      const spend = (t: BuildingType) => {
        let c = -1;
        if (t === 'port') {
          // порт ставится только на свой океанский берег, farthest-point тут не годится
          for (let i = (Math.random() * step) | 0; i < cells.length; i += step) {
            if (this.canBuildPort(p.id, cells[i]) && !this.buildingNear(cells[i], PORT_RADIUS, EX)) {
              c = cells[i];
              break;
            }
          }
        } else if (t === 'hq' && enemyFrom >= 0) {
          // штаб обороны — к угрожаемой границе, а не в глубокий тыл
          c = this.borderBuildCell(p.id, enemyFrom);
        }
        if (c < 0 && t !== 'port') c = this.spreadBuildCell(p.id, cells, step);
        if (c < 0) return false;
        return this.build(p.id, t, c) === null;
      };

      // есть ли выход к океану — иначе порты строить некуда
      let coastal = false;
      for (let i = 0; i < cells.length; i += step) {
        if (this.owners[cells[i]] === p.id && this.shore[cells[i]]) { coastal = true; break; }
      }
      const cityCount = countType('city');
      const want: Partial<Record<BuildingType, number>> = {
        city: 4 + Math.floor(p.cells / 2500),
        port: coastal ? Math.max(1, Math.round(cityCount * BOT_RATIO_PORT)) : 0,
        factory: Math.max(1, Math.round(cityCount * BOT_RATIO_FACTORY)),
        sam: Math.max(2, Math.round(cityCount * BOT_RATIO_SAM * aggroSam)),
        silo: Math.min(BOT_MAX_SILO, Math.max(1, Math.round(cityCount * BOT_RATIO_SILO))),
        hq: Math.max(1, Math.round(cityCount * BOT_RATIO_HQ)),
      };
      // Порог плотности из OpenFront (UPGRADE_DENSITY_THRESHOLD = 1 постройка на
      // 1500 клеток) нам не подходит: у них у игрока единицы построек, у нас — сотни
      // (одних городов больше сотни на страну). При таком пороге «плотно» наступало
      // почти сразу и ВЫКЛЮЧАЛО всю фазу расширения — ПВО строились только по
      // обязательному минимуму, то есть по одному, и покрытия территории не было.
      // Ограничителем количества служат цели want (доля от числа городов), а
      // «некуда ставить» и так определяется тем, что spend() не находит клетку.
      const dense = mine.length > p.cells * BOT_UPGRADE_DENSITY;
      // Боевая касса: не тратим её на стройку, иначе не остаётся ни на ракету, ни
      // на рой дронов. Пока идёт наше наступление — копим на рой.
      // Касса включается, ТОЛЬКО когда шахта уже есть: она стоит всего 1 млн, а
      // средние деньги страны — единицы миллионов, поэтому безусловная касса
      // делала бюджет отрицательным и бот не строил вообще ничего.
      const chest = hasSilo ? (atWar ? BOT_CHEST_WAR : BOT_CHEST_BASE) : 0;
      const spendable = p.money - chest;
      const newCost = (t: BuildingType) =>
        t === 'city' ? cityCost(countType('city'))
        : t === 'port' ? portCost(this.portLevels(p.id))
        : t === 'factory' ? factoryCost(this.factoryLevels(p.id))
        : t === 'sam' ? samCost(this.samLevels(p.id))
        : t === 'silo' ? SILO_COST
        : hqCost(this.hqCount(p.id));
      const upCost = (b: Building) =>
        b.type === 'city' ? cityUpgradeCost(b.level + 1)
        : b.type === 'port' ? portUpgradeCost(b.level + 1)
        : b.type === 'factory' ? factoryCost(this.factoryLevels(p.id))
        : b.type === 'sam' ? samCost(this.samLevels(p.id))
        : b.type === 'silo' ? SILO_COST
        : hqUpgradeCost(b.level + 1);
      // Порядок достройки: сперва ЭКОНОМИКА (порт, завод), потом оборона (ПВО),
      // потом наступление (шахта), щит и города. Раньше ПВО имели абсолютный
      // приоритет, а экономика получала только остаток сверх запаса в 2 млн.
      // Шахта раньше ПВО: она дешёвая (1 млн) и открывает и ракеты, и рой дронов, а
      // ПВО без чужих шахт защищать нечего.
      const buildOrder: BuildingType[] = ['port', 'factory', 'silo', 'sam', 'hq', 'city'];
      // ОБЯЗАТЕЛЬНЫЙ МИНИМУМ до расширения экономики. Без него цели по портам и
      // заводам (доля от числа городов — это десятки штук) создают вечный дефицит,
      // и деньги никогда не доходят до шахты и ПВО: в замере страна доживала до
      // 6000-го тика с 39 портами 12-го уровня и НУЛЁМ шахт, то есть не запускала
      // ни ракет, ни роя дронов вообще.
      // Минимум — только ДЕШЁВАЯ база. Шахту и ПВО сюда включать нельзя: на них бот
      // копит, а копить, ничего не строя и не улучшая, он может очень долго — в
      // замере это давало 112 городов и 23 порта, все 1-го уровня, потому что до
      // апгрейдов дело не доходило вообще.
      const minWant: Partial<Record<BuildingType, number>> = {
        city: 4,
        hq: 1,
        port: coastal ? 1 : 0,
        factory: 1,
        silo: 1,
        sam: 1,
      };
      // Порядок минимума: сперва ДЕШЁВАЯ база (город 50к, штаб 40к, порт 50к,
      // завод 125к), и только потом дорогая «техника», на которую бот копит
      // (шахта 1 млн, ПВО 1.5 млн). Если поставить шахту раньше городов, бот копит
      // на неё и не строит вообще ничего: в замере — 0 городов, 0 штабов, 0 ПВО.
      // ПВО раньше шахты: оборона важнее наступления, и раньше бот, не накопив на
      // шахту (1 млн), до ПВО просто не доходил.
      const minOrder: BuildingType[] = ['city', 'hq', 'port', 'factory', 'sam', 'silo'];
      // Порядок апгрейдов: ПОРТ первым — это главный источник дохода (уровень порта
      // задаёт и число торговых судов, и цену рейса, поэтому порт 14-го уровня
      // приносит примерно в двадцать раз больше первого). Раньше первым стояло ПВО,
      // и бот всю партию жил на доходе портов 1-го уровня — отсюда и «нет денег ни
      // на ракеты, ни на рой дронов».
      const upOrder: BuildingType[] = ['port', 'factory', 'city', 'sam', 'silo', 'hq'];
      const maxLvl: Partial<Record<BuildingType, number>> = {
        hq: MAX_HQ_LEVEL,
        sam: BOT_MAX_SAM_LEVEL,
        silo: BOT_MAX_SILO_LEVEL,
        factory: BOT_MAX_FACTORY_LEVEL,
      };
      const haveOf = (t: BuildingType) => (t === 'hq' ? this.hqCount(p.id) : countType(t));
      let newB = 0; // новых построек за ход (farthest-point дорогой)
      // ПВО и ракетные шахты ставятся ПАЧКОЙ: первое — покрытие площади, второе —
      // глубина залпа, и того и другого нужно несколько сразу. Остальное — по одной
      // постройке за ход (выбор места farthest-point дорогой). Стройка не
      // сериализуется: здания возводятся параллельно, поэтому очередь работает.
      const queued = new Map<BuildingType, number>(); // ПВО/шахт в очереди за ход
      const batchable = (t: BuildingType) => t === 'sam' || t === 'silo';
      const canStart = (t: BuildingType) =>
        batchable(t) ? (queued.get(t) ?? 0) < BOT_QUEUE_BATCH : newB < 4;
      const noteStart = (t: BuildingType) => {
        if (batchable(t)) queued.set(t, (queued.get(t) ?? 0) + 1);
        else newB++;
      };

      // === 1. ОБЯЗАТЕЛЬНЫЙ МИНИМУМ ===
      // Пока он не выполнен, бот КОПИТ на него. Если постройку некуда поставить —
      // не блокируемся, идём дальше (иначе бот замирал бы навсегда).
      let missing: BuildingType | null = null;
      for (const t of minOrder) {
        while (haveOf(t) < (minWant[t] ?? 0)) {
          const cost = newCost(t);
          if (p.money < cost) { missing = t; break; }
          if (!canStart(t) || !spend(t)) break;
          noteStart(t);
        }
        if (missing) break;
      }

      // === 2. ЦЕЛЬ НАКОПЛЕНИЯ И СВОБОДНЫЙ БЮДЖЕТ ===
      // Копим либо на недостающую обязательную постройку, либо (если минимум есть,
      // идёт наше наступление и есть шахта) на рой дронов, либо держим небольшой
      // запас на ракету.
      // Цель на рой дронов — МЯГКАЯ: включается только когда бот уже нащупал
      // деньги (сорок процентов стоимости). Иначе недостижимая цель в 11 млн
      // заклинивала всё: бюджет всегда отрицательный, бот сидел в режиме
      // накопления и не строил и не улучшал ничего, кроме портов.
      const droneGoal = DRONE_COST + BOT_CHEST_BASE;
      // Цель на рой — ПОСТОЯННАЯ, как только есть шахта. Привязка к «сейчас идёт
      // атака» не работала: состояние мимолётное, и накопления тут же сбрасывались
      // обратно в стройку — за 14 000 тиков не вылетело ни одного роя.
      // Копим на рой только когда он в пределах досягаемости (см. strikeReserve),
      // иначе бот вечно сидит в режиме накопления на недостижимую цель.
      const goal = missing
        ? newCost(missing)
        : hasSilo && p.money >= DRONE_COST * 0.5
          ? droneGoal
          : BOT_CHEST_BASE;
      let budget = p.money - goal;

      if (budget <= 0) {
        // ДЕНЕГ НА ЦЕЛЬ НЕ ХВАТАЕТ — значит надо их ЗАРАБОТАТЬ, а не сидеть и копить
        // на статичном доходе. Вкладываемся в экономику по отдаче:
        //   1) новый порт — линейный прирост дохода;
        //   2) уровень порта — уровень задаёт И число торговых судов, И цену рейса,
        //      поэтому доход растёт быстрее, чем цена апгрейда (30к × уровень);
        //   3) завод — золото с суши и ускорение регена.
        // Вкладываем только ДОЛЮ денег (BOT_ECON_SHARE), остальное накапливается:
        // иначе «зарабатывай, если не хватает» превращается в вечное вложение —
        // доход растёт, а на счету всегда ноль, и до роя дронов бот не доживает.
        // Пока копим на ПВО или шахту — НЕ вкладываемся: это разовые крупные суммы
        // (1.5 и 1 млн), а вложения «доля от текущих денег» ровно съедают доход, и
        // накопление стоит на месте (в замере равновесие на 0.7 млн при цели 1.5).
        // На дешёвую базу (город/штаб/порт/завод) копить не нужно — она и есть экономика.
        const savingHard = missing === 'sam' || missing === 'silo';
        let econ = savingHard ? 0 : p.money * BOT_ECON_SHARE;
        for (let act = 0; act < 6 && econ > 0; act++) {
          let did = false;
          if (coastal && newB < 4 && countType('port') < (want.port ?? 0)) {
            const cost = portCost(this.portLevels(p.id));
            if (econ >= cost && spend('port')) { econ -= cost; newB++; did = true; }
          }
          if (!did) {
            const pb = lowestOf('port', PORT_MAX_SHIP_LEVEL);
            const cost = pb ? upCost(pb) : Infinity;
            if (pb && econ >= cost && this.upgrade(p.id, pb.cell) === null) { econ -= cost; did = true; }
          }
          if (!did) {
            const fb = lowestOf('factory');
            const cost = fb ? upCost(fb) : Infinity;
            if (fb && econ >= cost && this.upgrade(p.id, fb.cell) === null) { econ -= cost; did = true; }
          }
          if (!did) break;
        }
      } else {
        // === 3. РАСШИРЕНИЕ И АПГРЕЙДЫ на свободные деньги ===
        const builtNow = new Set<BuildingType>();
        const upNow = new Set<BuildingType>();
        for (let act = 0; act < 24 && budget > 0; act++) {
          let did = false;
          if (!dense) {
            for (const t of buildOrder) {
              // ПВО и шахты можно ставить пачкой в один ход, остальное — по одному
              if (!batchable(t) && builtNow.has(t)) continue;
              if (!canStart(t) || haveOf(t) >= (want[t] ?? 0)) continue;
              const cost = newCost(t);
              if (budget < cost) continue;
              builtNow.add(t);
              if (!spend(t)) continue;
              budget -= cost;
              noteStart(t);
              did = true;
              break;
            }
          }
          if (did) continue;
          for (const t of upOrder) {
            if (upNow.has(t)) continue;
            const b = lowestOf(t, maxLvl[t] ?? Infinity);
            if (!b) continue;
            const cost = upCost(b);
            if (budget < cost) continue;
            upNow.add(t);
            if (this.upgrade(p.id, b.cell) !== null) continue;
            budget -= cost;
            did = true;
            break;
          }
          if (!did) break;
        }
      }
      // пуск ракеты по врагу: если есть заряженная шахта и деньги. Целимся в
      // СТРАТЕГИЧЕСКИЕ объекты врага (шахта > ПВО > завод > штаб > город), а если
      // таких нет — вглубь его территории. Богатая страна иногда бьёт водородной.
      // Пока идёт наше наступление, приоритет удара — за роем дронов: ракеты не
      // должны съедать деньги, отложенные на рой. Раньше бот при каждом удобном
      // случае тратил накопления на ракету (750к), поэтому до 10 млн на рой не
      // доживал никогда — за партию не вылетало ни одного роя.
      // Резерв на рой копим, только когда рой уже В ПРЕДЕЛАХ ДОСЯГАЕМОСТИ (половина
      // стоимости на руках). Постоянный резерв блокировал ракеты навсегда: пик
      // денег бота за партию — около 6.5 млн, то есть до 10 млн он не доходит, и
      // при жёстком резерве бот не запускал НИЧЕГО — ни роя, ни ракет.
      // Пуск ракеты обязан считаться с НАКОПЛЕНИЯМИ. Раньше проверка смотрела только
      // на свою цену (750к), поэтому съедала деньги, отложенные на ПВО: бот копил на
      // первое ПВО (1.5 млн), на 750к запускал ракету — и всё начиналось заново. В
      // замере страны доходили до конца партии с 0 ПВО при доходе на 5–10 штук.
      const droneReserve = hasSilo && p.money >= DRONE_COST * 0.5 ? DRONE_COST : 0;
      const strikeReserve = missing ? Math.max(goal, droneReserve) : droneReserve;
      if (
        enemyTo >= 0 &&
        Math.random() < 0.15 &&
        p.money >= NUKES.basic.cost + strikeReserve &&
        this.buildings.some((b) => b.owner === p.id && b.type === 'silo' && this.tickNo >= b.readyTick && b.stock > 0)
      ) {
        const kind = p.money >= NUKES.hydro.cost && Math.random() < 0.35 ? 'hydro' : 'basic';
        const fx = enemyFrom % this.w, fy = (enemyFrom / this.w) | 0;
        const prio: Record<string, number> = { silo: 5, sam: 4, factory: 3, hq: 2, city: 1 };
        let targetCell = -1, bestScore = -Infinity;
        for (const b of this.buildings) {
          const pr = prio[b.type];
          if (!pr || b.owner === p.id || b.owner <= 0) continue;
          if (this.relation(p.id, b.owner) === 'allied') continue;
          const bx = b.cell % this.w, by = (b.cell / this.w) | 0;
          const d2 = (bx - fx) ** 2 + (by - fy) ** 2;
          if (d2 > 500 * 500) continue; // слишком далеко — не бьём через полмира
          const score = pr * 1e7 - d2; // приоритет типа, при равенстве — ближе
          if (score > bestScore) { bestScore = score; targetCell = b.cell; }
        }
        if (targetCell < 0) {
          // стратегических целей нет — бьём вглубь территории врага (как раньше)
          const R = NUKES[kind].radius;
          const ex = enemyTo % this.w, ey = (enemyTo / this.w) | 0;
          const dx = ex - fx, dy = ey - fy, len = Math.hypot(dx, dy) || 1;
          const tx = Math.max(0, Math.min(this.w - 1, Math.round(ex + (dx / len) * R)));
          const ty = Math.max(0, Math.min(this.h - 1, Math.round(ey + (dy / len) * R)));
          targetCell = ty * this.w + tx;
        }
        this.launchNuke(p.id, targetCell, kind);
      }
      // Рой дронов «Мопед» — часть НАСТУПЛЕНИЯ, а не редкая случайность. Раньше
      // шанс был 4% при любых условиях, и рой практически никогда не вылетал: к
      // тому же бот тратил все деньги на стройку и до 10 млн не доживал. Теперь
      // деньги на удар придерживаются боевой кассой (BOT_CHEST_WAR), а пока идёт
      // наше наступление бот бьёт роем часто и может послать ДВЕ волны подряд —
      // так перелом выглядит логично и динамично.
      if (enemyTo >= 0 && hasSilo) {
        const chance = atWar ? BOT_DRONE_CHANCE_WAR : BOT_DRONE_CHANCE_IDLE;
        for (let wave = 0; wave < BOT_DRONE_WAVES; wave++) {
          if (p.money < DRONE_COST || Math.random() >= chance) break;
          if (this.launchDrones(p.id, enemyTo) !== null) break; // не вышло — не пытаемся снова
        }
      }
      // Флот: строит боевые корабли, прикрывает берег/торговлю, перехватывает
      // вражеские десанты; изредка сам высаживает десант на чужой берег/остров.
      if (Math.random() < 0.35) this.botFleet(p);
      if (Math.random() < 0.08 && p.troops > p.maxTroops * 0.5) this.botSeaInvade(p);
      // активно занимаем пустые острова, пока есть свободные войска
      if (Math.random() < 0.2 && p.troops > p.maxTroops * 0.35) this.botColonize(p);

      // СОЮЗЫ МЕЖДУ БОТАМИ. Раньше бот заключал союз только в коалиции против
      // оторвавшегося лидера, поэтому обычной дипломатии между странами не было
      // вовсе: они лишь копили враждебность через бои. Теперь сосед-страна, с
      // которой мы ещё нейтральны и которая сопоставима по силе, иногда становится
      // союзником — это и даёт мирные границы, и открывает торговлю (партнёр по
      // трейду обязан быть НЕ враждебным).
      if (Math.random() < 0.2) {
        for (const k of counts.keys()) {
          if (k <= 0 || k === p.id) continue;
          if (this.relation(p.id, k) !== 'neutral') continue;
          const other = this.players.get(k);
          if (!other?.alive || !other.bot) continue;
          const pw = this.powerOf(p.id);
          const ow = this.powerOf(k);
          // союз имеет смысл с сопоставимым соседом: слабого проще съесть, а
          // намного более сильный всё равно не станет считаться с нами
          if (ow < pw * 0.6 || ow > pw * 1.8) continue;
          this.acceptAlliance(p.id, k);
          break;
        }
      }

      // КОАЛИЦИЯ ПРОТИВ ЛИДЕРА (средняя+ сложность): если сильнейший игрок явно
      // оторвался — боты союзничают между собой и совместно бомбят его инфраструктуру.
      // Чем выше сложность, тем чаще удары по сильнейшему.
      const coalition = DIFFICULTY[this.difficulty].coalition;
      if (coalition > 0) {
        const leader = this.currentLeader();
        if (leader > 0 && leader !== p.id && this.powerOf(leader) > this.powerOf(p.id) * 1.3) {
          // 1) союзы коалиции — с другими НЕ-лидерами-ботами (чтобы не грызться,
          //    а давить лидера вместе)
          if (Math.random() < 0.25 * coalition) {
            for (const k of counts.keys()) {
              if (k <= 0 || k === leader) continue;
              const other = this.players.get(k);
              if (other?.alive && other.bot && this.relation(p.id, k) === 'neutral') {
                this.acceptAlliance(p.id, k);
                break;
              }
            }
          }
          // 2) бомбим инфраструктуру лидера ядеркой (даже не граничя с ним)
          if (
            Math.random() < 0.08 + 0.4 * coalition &&
            p.money >= NUKES.basic.cost + strikeReserve &&
            this.buildings.some((b) => b.owner === p.id && b.type === 'silo' && this.tickNo >= b.readyTick && b.stock > 0)
          ) {
            const from = this.playerCells(p.id)[0] ?? 0;
            const fx0 = from % this.w, fy0 = (from / this.w) | 0;
            const prio: Record<string, number> = { silo: 5, sam: 4, factory: 3, hq: 2, city: 1 };
            let tc = -1, bs = -Infinity;
            for (const b of this.buildings) {
              if (b.owner !== leader) continue;
              const pr = prio[b.type];
              if (!pr) continue;
              const bx = b.cell % this.w, by = (b.cell / this.w) | 0;
              const score = pr * 1e7 - ((bx - fx0) ** 2 + (by - fy0) ** 2);
              if (score > bs) { bs = score; tc = b.cell; }
            }
            if (tc >= 0) {
              const kind = p.money >= NUKES.hydro.cost && Math.random() < 0.5 ? 'hydro' : 'basic';
              this.launchNuke(p.id, tc, kind);
            }
          }
        }
      }
    }

    // Страны: агрессия зависит от сложности
    const aggro = DIFFICULTY[this.difficulty].aggro;
    p.thinkAt = this.tickNo + Math.round(18 / aggro) + ((Math.random() * 30) | 0);
    // Порог начала наступления (их triggerRatio)
    const trigger = BOT_TRIGGER / Math.max(1, aggro);
    if (p.troops < p.maxTroops * trigger || p.troops < 150) return;
    if (!counts.size) return;

    // === Сколько войск бот вообще может отправить ===
    // 1) РЕЗЕРВ: доля потолка всегда остаётся дома. Раньше бот отправлял ровно
    //    половину армии независимо ни от чего, уходил в ноль и не мог обороняться.
    const reserve = p.maxTroops * BOT_RESERVE;
    // 2) уже вложенное в наши атаки: наступление не «докапываем» второй волной —
    //    с COMMITTED_COUNTS это к тому же придавливает свой же прирост
    let inFlight = 0;
    for (const a of this.attacks) if (a.player === p.id) inFlight += a.troops;
    let send = Math.floor(Math.min(p.troops - reserve, p.troops * 0.5) - inFlight);
    if (send < 150) return;
    // 3) СТРАЖ СИЛЬНЕЙШЕГО СОСЕДА (их troopSendCap): не опускаем гарнизон ниже
    //    доли войск самого сильного не-союзного соседа, иначе бот уходит в атаку
    //    и его тут же съедают с другой стороны.
    let strongestFoe = 0;
    for (const k of counts.keys()) {
      if (k <= 0 || this.relation(p.id, k) === 'allied') continue;
      const q = this.players.get(k);
      if (q?.alive && q.troops > strongestFoe) strongestFoe = q.troops;
    }
    send = Math.min(send, Math.floor(p.troops - strongestFoe * BOT_GUARD));
    if (send < 150) return;
    // Предательство: если бот заметно сильнее граничащего союзника и его самого
    // не давит более сильный враг — иногда рвёт союз и бьёт в спину.
    if (Math.random() < 0.06 * aggro) {
      const pressured = [...(this.hostiles.get(p.id) ?? [])].some((f) => this.powerOf(f) > this.powerOf(p.id) * 1.1);
      if (!pressured) {
        for (const k of counts.keys()) {
          if (k <= 0 || this.relation(p.id, k) !== 'allied') continue;
          if (this.powerOf(p.id) > this.powerOf(k) * 1.3) {
            this.breakAllianceId(p.id, k); // разрыв союза снимает защиту — можно бить
            this.launchAttackOwner(p.id, k, Math.floor(p.troops * 0.5));
            return;
          }
        }
      }
    }
    let target = -1;
    // ОТВЕТНЫЙ УДАР (их findIncomingAttackPlayer): если нас бьют, приоритетная
    // цель — самый крупный нападающий, а не случайный слабый сосед на другой
    // стороне. Раньше бот под ударом продолжал спокойно есть «корм».
    if (this.tickNo - p.hurtTick < BOT_RETALIATE_TICKS) {
      let biggest = 0;
      for (const a of this.attacks) {
        if (a.target !== p.id || a.troops <= biggest) continue;
        if (this.relation(p.id, a.player) === 'allied') continue;
        biggest = a.troops;
        target = a.player;
      }
      if (target > 0 && send >= biggest * BOT_MIN_ODDS) {
        this.launchAttackOwner(p.id, target, send);
        return;
      }
      target = -1;
    }
    const coal = DIFFICULTY[this.difficulty].coalition;
    const leader = coal > 0 ? this.currentLeader() : 0;
    // в коалиции: если граничим с оторвавшимся лидером — чаще бьём именно его
    if (
      leader > 0 && leader !== p.id && counts.has(leader) &&
      this.powerOf(leader) > this.powerOf(p.id) * 1.3 &&
      Math.random() < 0.5 + 0.5 * coal
    ) {
      target = leader;
    } else {
      // Цель выбирается по ЦЕНЕ ПРОРЫВА, а не по «слабости вообще». У нас цена
      // клетки ∝ плотности обороны, а темп ∝ ширине фронта — значит лучший сосед
      // тот, у кого низкая плотность и широкая граница с нами. counts как раз
      // хранит ширину границы по каждому соседу. (В OpenFront соседи-боты
      // сортируются по density = troops/tiles — та же идея.)
      // Свободная нейтраль участвует в том же сравнении по своей цене, поэтому
      // бот сам предпочтёт даровую землю, пока она есть, вместо случайного броска.
      const neutralWidth = counts.get(0) ?? 0;
      let bestScore = neutralWidth > 0 ? neutralWidth / NEUTRAL_COST : -Infinity;
      target = neutralWidth > 0 ? 0 : -1;
      for (const [k, width] of counts) {
        if (k <= 0 || this.relation(p.id, k) === 'allied') continue;
        const q = this.players.get(k);
        if (!q?.alive) continue;
        // безнадёжные атаки не начинаем вовсе (их isAttackTooWeak): при таком
        // соотношении сил клетка ещё и вдвое дороже — чистая потеря войск
        if (send < q.troops * BOT_MIN_ODDS) continue;
        const dens = q.cells > 0 ? q.troops / q.cells : 0;
        // агрессия по сложности склоняет выбор к живым соседям, а не к нейтрали
        const score = (width / (1 + 2 * dens)) * aggro;
        if (score > bestScore) { bestScore = score; target = k; }
      }
      if (target < 0) return; // некого бить по силам — копим войска
    }
    this.launchAttackOwner(p.id, target, send);
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
      upQueue: b.upQueue,
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
      // сколько секунд осталось идти: отозванный возвращается к началу маршрута
      eta: Math.max(0, (b.returning ? b.traveled : b.totalLen - b.traveled) / BOAT_SPEED / 10),
      returning: b.returning,
    }));
  }
}
