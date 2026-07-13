import {
  PlayerPub,
  AttackPub,
  BoatPub,
  BuildingPub,
  BuildingType,
  TradeShipPub,
  TruckPub,
  WarshipPub,
  TradeEarn,
  MissilePub,
  NUKES,
  HQ_RADIUS,
  HQ_EXPLODE_RADIUS,
  PORT_RADIUS,
  SAM_RANGE,
  FACTORY_RANGE,
} from '../../shared/protocol';
import { playerColorRGB, playerColorCSS } from '../../shared/color';
import { rleDecode } from '../../shared/rle';
import {
  FORT_BORDER,
  WATER,
  WAR,
  LABEL_ZOOM_MUL,
  FOOD_LABEL_MUL,
  FOOD_LABEL_CELLS,
  TERRAIN,
} from './constants';
import { fmtTroops, fmtMoney } from '../lib/format';
import { drawShips, drawMissiles, drawFleet } from './render/projectiles';

export class GameClient {
  w = 0;
  h = 0;
  cells = 0;
  terrain = new Uint8Array(0);
  owners = new Int16Array(0);
  selfId = -1;
  fps = 0;

  onCellClick: ((cell: number, screenX: number, screenY: number) => void) | null = null;
  onCellRightClick: ((cell: number, screenX: number, screenY: number) => void) | null = null;
  onBuild: ((cell: number) => void) | null = null;
  onFleetMove: ((cell: number) => void) | null = null; // приказ выделенным кораблям

  // режим постройки: тип здания или null; клетка под курсором для предпросмотра
  buildMode: BuildingType | null = null;
  nukeKind: string | null = null; // выбранный тип ракеты для наведения (null = нет)
  active = false; // рисуем карту только в игре (в меню/лобби — не жжём кадры впустую)
  fleetMode = false; // выбран инструмент «Флот» — клик выпускает боевой корабль
  warships: WarshipPub[] = []; // боевые корабли (читает engine/render)
  selectedWarships = new Set<number>(); // выделенные свои корабли (RTS-выделение)
  bullets: number[] = []; // пули кораблей в полёте: [x0,y0,x1,y1,...] (клетки)
  selBox: { x0: number; y0: number; x1: number; y1: number } | null = null; // рамка выделения
  private hoverCell = -1;
  missiles: MissilePub[] = []; // ракеты в полёте (читает engine/render)
  private buildings: BuildingPub[] = [];
  private fortField = new Int16Array(0); // владелец штаба на клетку (укрепления)
  private buildingsSig = '';
  private flashes: { cell: number; t0: number; big: boolean; nuke?: boolean }[] = []; // вспышки взрыва
  private boatCum = new Map<
    number,
    { len: number; cum: number[]; total: number; wob: number[] }
  >();
  private boatProg = new Map<number, number>(); // интерполированный прогресс лодок

  private img: ImageData | null = null;
  private off = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;
  private dirty = true;

  private players: PlayerPub[] = [];
  private playersTick = 0; // троттлинг отображаемых армий на карте (раз в 1с)
  private labels = new Map<number, { x: number; y: number }>();
  private miniCanvas: HTMLCanvasElement | null = null;
  private miniCtx: CanvasRenderingContext2D | null = null;
  private emojiCache = new Map<string, HTMLCanvasElement>(); // спрайты иконок (кэш)
  private miniScale = 1; // масштаб миникарты (её пиксели / клетки карты)
  private miniPanX = NaN; // камера на последней отрисовке миникарты (для пропуска кадров)
  private miniPanY = NaN;
  private miniZoom = NaN;

  private attacks: AttackPub[] = [];
  private boats: BoatPub[] = [];
  ships: TradeShipPub[] = []; // трейд-корабли (читает engine/render)
  trucks: TruckPub[] = []; // грузовики заводов на дорогах
  roadLines: number[][] = []; // дороги от сервера: ломаные [x,y,...] в клетках
  private moneyPops: { x: number; y: number; amount: number; t0: number }[] = []; // всплывашки заработка
  allies = new Set<number>(); // мои союзники
  enemies = new Set<number>(); // мои враги (нельзя торговать)
  private warSet = new Set<number>(); // с кем воюем: атакуем мы или атакуют нас
  private warLabels: { x: number; y: number; lines: string[] }[] = [];
  // сглаженные цвета нейтральной земли (переходы биомов), статичны за раунд
  private neutralRGB = new Uint8ClampedArray(0);
  private labelTick = 0;
  private warTick = 0;

  // камера публична — читается модулями рендера (engine/render/*)
  zoom = 3;
  panX = 0;
  panY = 0;

  // плавная анимация камеры (автозум к спавну)
  private anim: {
    t0: number;
    dur: number;
    fromX: number;
    fromY: number;
    fromZ: number;
    toX: number;
    toY: number;
    toZ: number;
  } | null = null;

  constructor() {
    this.offCtx = this.off.getContext('2d')!;
  }

  applyInit(selfId: number, w: number, h: number, terrainRle: number[], ownersRle: number[]) {
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.cells = w * h;
      this.terrain = new Uint8Array(this.cells);
      this.owners = new Int16Array(this.cells);
      this.img = new ImageData(w, h);
      this.off.width = w;
      this.off.height = h;
      this.sizeMinimap();
    }
    rleDecode(terrainRle, this.terrain);
    rleDecode(ownersRle, this.owners);
    if (selfId > 0) this.selfId = selfId;
    this.warSet.clear();
    this.warLabels = [];
    this.buildings = [];
    this.buildingsSig = '';
    this.moneyPops = [];
    this.ships = [];
    this.missiles = [];
    this.fortField = new Int16Array(this.cells);
    this.buildNeutralColors();
    this.repaintAll();
    this.fitView();
  }

  // Усредняем цвета биомов по окрестности 3x3 — плавные переходы между
  // травой, песком, камнем и снегом
  private buildNeutralColors() {
    this.neutralRGB = new Uint8ClampedArray(this.cells * 3);
    const w = this.w, h = this.h;
    // карта Земли (крупная) — рельефная закраска с тенями; случайная — плоские
    // биомы со сглаживанием (как раньше, чтобы не трогать рандом-генерацию)
    if (w < 1000) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = y * w + x;
          if (!this.terrain[c]) continue;
          let r = 0, g = 0, b = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const t = this.terrain[ny * w + nx];
              if (!t) continue;
              const col = TERRAIN[t] ?? TERRAIN[1];
              r += col[0]; g += col[1]; b += col[2]; n++;
            }
          }
          this.neutralRGB[c * 3] = r / n;
          this.neutralRGB[c * 3 + 1] = g / n;
          this.neutralRGB[c * 3 + 2] = b / n;
        }
      }
      return;
    }
    this.buildReliefColors();
  }

  // --- Рельефная закраска карты Земли (hillshade) ---
  private static hash2(ix: number, iy: number): number {
    const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  private static vnoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const H = GameClient.hash2;
    const a = H(ix, iy), b = H(ix + 1, iy), c = H(ix, iy + 1), d = H(ix + 1, iy + 1);
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  private static fbm(x: number, y: number): number {
    const V = GameClient.vnoise;
    return V(x, y) * 0.55 + V(x * 2.3 + 37, y * 2.3 + 91) * 0.3 + V(x * 5.1 + 11, y * 5.1 + 7) * 0.15;
  }

  private buildReliefColors() {
    const w = this.w, h = this.h, N = this.cells;
    const T = this.terrain;
    // «горность» из биома (камень/снег), размытая — плавно приподнимает горы
    const mf = new Float32Array(N);
    for (let c = 0; c < N; c++) mf[c] = T[c] === 3 || T[c] === 4 ? 1 : 0;
    const tmp = new Float32Array(N);
    for (let it = 0; it < 3; it++) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0, n = 0;
          for (let d = -2; d <= 2; d++) { const nx = x + d; if (nx < 0 || nx >= w) continue; s += mf[y * w + nx]; n++; }
          tmp[y * w + x] = s / n;
        }
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0, n = 0;
          for (let d = -2; d <= 2; d++) { const ny = y + d; if (ny < 0 || ny >= h) continue; s += tmp[ny * w + x]; n++; }
          mf[y * w + x] = s / n;
        }
    }
    // высота один раз в массив (шум + приподнятые горы с хаотичными грядами)
    const F = GameClient.fbm;
    const E = new Float32Array(N);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        if (!T[c]) { E[c] = -0.5; continue; }
        // ridged-шум — острые гребни; в горах даёт хаотичный хребтовый рельеф
        const ridged = 1 - Math.abs(F(x / 9 + 21, y / 9 + 8) * 2 - 1);
        E[c] = F(x / 55 + 9, y / 55 + 4) * 0.5 + F(x / 16 + 31, y / 16 + 7) * 0.3 +
          F(x / 6 + 99, y / 6 + 55) * 0.2 + mf[c] * 0.75 + mf[c] * ridged * 0.9;
      }
    const SHADE = 6;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        if (!T[c]) continue;
        const base = TERRAIN[T[c]] ?? TERRAIN[1];
        const e = E[c];
        const eR = x + 1 < w && T[c + 1] ? E[c + 1] : e;
        const eD = y + 1 < h && T[c + w] ? E[c + w] : e;
        // свет с северо-запада: склоны, поднимающиеся к юго-востоку (обращённые к
        // свету), светлее — вершины выглядят приподнятыми, а не утопленными
        let sh = 1 + ((eR - e) + (eD - e)) * SHADE;
        sh = Math.max(0.68, Math.min(1.35, sh));
        this.neutralRGB[c * 3] = Math.min(255, base[0] * sh);
        this.neutralRGB[c * 3 + 1] = Math.min(255, base[1] * sh);
        this.neutralRGB[c * 3 + 2] = Math.min(255, base[2] * sh);
      }
    }
  }

  // Полный ресинк владельцев (после отставания клиента) — без смены фазы
  resync(ownersRle: number[]) {
    if (!this.cells) return;
    rleDecode(ownersRle, this.owners);
    this.repaintAll();
  }

  applyUpdate(changes: number[]) {
    if (!changes.length || !this.cells) return;
    for (let i = 0; i < changes.length; i += 2) {
      this.owners[changes[i]] = changes[i + 1];
    }
    // перекрашиваем изменённые клетки и соседей (у них могла поменяться граница)
    for (let i = 0; i < changes.length; i += 2) {
      const c = changes[i];
      this.paint(c);
      const x = c % this.w;
      if (x > 0) this.paint(c - 1);
      if (x < this.w - 1) this.paint(c + 1);
      if (c >= this.w) this.paint(c - this.w);
      if (c < this.cells - this.w) this.paint(c + this.w);
    }
    this.dirty = true;
  }

  // Центроиды территорий — точки, где рисуем имена игроков. Пересчёт редкий
  // (раз в ~2с) и только когда карта приближена настолько, что метки видны
  setPlayers(players: PlayerPub[]) {
    // отображаемые имена и армии на карте (в т.ч. у ботов и стран) обновляем
    // визуально раз в 1с — иначе числа мельтешат каждый тик
    if (this.playersTick++ % 10 === 0) this.players = players;
    if (!this.labelsVisible()) return; // отдалено — метки не рисуются
    if (this.labelTick++ % 20 !== 0) return;
    const acc = new Map<number, { sx: number; sy: number; n: number }>();
    for (let c = 0; c < this.cells; c++) {
      const o = this.owners[c];
      if (o <= 0) continue;
      let a = acc.get(o);
      if (!a) {
        a = { sx: 0, sy: 0, n: 0 };
        acc.set(o, a);
      }
      a.sx += c % this.w;
      a.sy += (c / this.w) | 0;
      a.n++;
    }
    this.labels.clear();
    for (const [id, a] of acc) {
      this.labels.set(id, { x: a.sx / a.n + 0.5, y: a.sy / a.n + 0.5 });
    }
  }

  setShips(ships: TradeShipPub[]) {
    this.ships = ships ?? [];
  }

  setTrucks(trucks: TruckPub[]) {
    this.trucks = trucks ?? [];
  }

  setRoads(roads: number[][]) {
    this.roadLines = roads ?? [];
  }

  // Дороги от завода к его городам/портам в радиусе + грузовики на них. Рисуем
  // ПОД зданиями. Порядок соединения тот же, что у грузовика (по возрастанию
  // дистанции), чтобы дорога совпадала с маршрутом.
  private drawRoads(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = this.zoom, px = this.panX, py = this.panY;
    // дороги приходят с сервера (проложены по суше, пересекают проливы)
    if (this.roadLines.length) {
      ctx.lineWidth = Math.max(2, z * 0.7);
      ctx.strokeStyle = 'rgba(214,208,190,0.9)'; // светлая сплошная дорога
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const line of this.roadLines) {
        if (line.length < 4) continue;
        ctx.beginPath();
        ctx.moveTo(px + line[0] * z, py + line[1] * z);
        for (let i = 2; i + 1 < line.length; i += 2) ctx.lineTo(px + line[i] * z, py + line[i + 1] * z);
        ctx.stroke();
      }
    }
    // грузовики — маленькие квадратики цвета владельца
    if (this.trucks.length) {
      const s = Math.max(2.5, z * 0.8);
      for (const t of this.trucks) {
        const tx = px + t.x * z, ty = py + t.y * z;
        ctx.fillStyle = playerColorCSS(t.owner);
        ctx.fillRect(tx - s, ty - s, s * 2, s * 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeRect(tx - s, ty - s, s * 2, s * 2);
      }
    }
  }

  setWarships(warships: WarshipPub[]) {
    this.warships = warships ?? [];
    // чистим выделение от исчезнувших (потопленных) кораблей
    if (this.selectedWarships.size) {
      const live = new Set(this.warships.map((w) => w.id));
      for (const id of [...this.selectedWarships]) if (!live.has(id)) this.selectedWarships.delete(id);
    }
  }

  // позиции пуль в полёте: [x0,y0,x1,y1,...] (клетки) — рисуем пикселями
  setShots(flat: number[]) {
    this.bullets = flat ?? [];
  }

  // id своего боевого корабля под курсором (экранные координаты) или -1
  myWarshipUnder(clientX: number, clientY: number): number {
    const rad = Math.max(11, Math.min(30, this.zoom * 4.5)) + 5;
    let best = -1, bestD = rad * rad;
    for (const wship of this.warships) {
      if (wship.owner !== this.selfId) continue;
      const sx = this.panX + wship.x * this.zoom;
      const sy = this.panY + wship.y * this.zoom;
      const d = (sx - clientX) ** 2 + (sy - clientY) ** 2;
      if (d < bestD) { bestD = d; best = wship.id; }
    }
    return best;
  }

  setMissiles(missiles: MissilePub[]) {
    const next = missiles ?? [];
    // ракета исчезла из списка → взрыв в цели, НО только если это долетевшая
    // ядерка (перехваченная/перехватчик — маленький «пшик», без ядерного гриба)
    if (this.missiles.length) {
      const nextIds = new Set(next.map((m) => m.id));
      for (const m of this.missiles) {
        if (nextIds.has(m.id)) continue;
        const cell = (Math.floor(m.ty) | 0) * this.w + (Math.floor(m.tx) | 0);
        if (m.intercept) {
          // перехватчик долетел — маленький «пшик» в точке встречи
          this.flashes.push({ cell, t0: performance.now(), big: false });
        } else if (m.prog >= 0.9) {
          // ядерка дошла до цели (не сбита) — ядерный взрыв
          this.flashes.push({ cell, t0: performance.now(), big: true, nuke: true });
        }
        // сбитая ядерка (исчезла на середине пути) — своей вспышки не даёт,
        // её гасит «пшик» перехватчика
      }
    }
    this.missiles = next;
  }

  // заработок портов — показываем только свои (КПД игрока)
  addEarnings(list: TradeEarn[]) {
    if (!list?.length) return;
    const now = performance.now();
    for (const e of list) {
      if (e.owner !== this.selfId) continue;
      this.moneyPops.push({ x: e.x, y: e.y, amount: e.amount, t0: now });
    }
  }

  setRelations(allies: number[], enemies: number[]) {
    this.allies = new Set(allies);
    this.enemies = new Set(enemies);
  }

  relationOf(id: number): 'self' | 'allied' | 'hostile' | 'neutral' {
    if (id === this.selfId) return 'self';
    if (this.allies.has(id)) return 'allied';
    if (this.enemies.has(id)) return 'hostile';
    return 'neutral';
  }

  setBoats(boats: BoatPub[]) {
    this.boats = boats;
    // чистим кэш у исчезнувших лодок
    if (this.boatCum.size > boats.length) {
      const ids = new Set(boats.map((b) => b.id));
      for (const id of this.boatCum.keys())
        if (!ids.has(id)) {
          this.boatCum.delete(id);
          this.boatProg.delete(id);
        }
    }
  }

  // Предрасчёт маршрута лодки: накопленная длина. Сам след повторяет маршрут (он
  // уже строго по воде на сервере) — без бокового «волнения», иначе линия вылезала
  // бы на сушу. Лёгкое покачивание даём самой лодке во времени при отрисовке.
  private buildBoatPath(path: number[], pts: number) {
    const cum = new Array(pts);
    cum[0] = 0;
    for (let i = 1; i < pts; i++) {
      cum[i] =
        cum[i - 1] +
        Math.hypot(path[i * 2] - path[(i - 1) * 2], path[i * 2 + 1] - path[(i - 1) * 2 + 1]);
    }
    const total = cum[pts - 1] || 1;
    return { len: path.length, cum, total, wob: path };
  }

  setBuildings(buildings: BuildingPub[]) {
    const next = buildings ?? [];
    // исчезнувшее здание = взрыв → вспышка (крупная у прокачанного)
    if (this.buildings.length) {
      const nextIds = new Set(next.map((b) => b.id));
      for (const ob of this.buildings) {
        if (!nextIds.has(ob.id)) {
          this.flashes.push({ cell: ob.cell, t0: performance.now(), big: ob.level >= 2 });
        }
      }
    }
    this.buildings = next;
    // пересобираем поле укреплений и перекрашиваем при изменении зданий или
    // завершении постройки (укрепление активно только у достроенных)
    const sig = this.buildings.map((b) => `${b.id}:${b.cell}:${b.progress >= 1 ? 1 : 0}`).join(',');
    if (sig !== this.buildingsSig) {
      this.buildingsSig = sig;
      this.rebuildFort();
      this.repaintAll();
    }
  }

  private rebuildFort() {
    if (this.fortField.length !== this.cells) this.fortField = new Int16Array(this.cells);
    else this.fortField.fill(0);
    const R = HQ_RADIUS;
    const R2 = R * R;
    for (const b of this.buildings) {
      if (b.progress < 1 || b.type !== 'hq') continue; // укрепляет только штаб
      const cx = b.cell % this.w;
      const cy = (b.cell / this.w) | 0;
      for (let dy = -R; dy <= R; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= this.h) continue;
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R2) continue;
          const x = cx + dx;
          if (x < 0 || x >= this.w) continue;
          this.fortField[y * this.w + x] = b.owner;
        }
      }
    }
  }

  buildingAt(cell: number): BuildingPub | undefined {
    return this.buildings.find((b) => b.cell === cell);
  }

  // Можно ли строить в клетке (та же логика, что на сервере) — для предпросмотра
  canBuildAt(cell: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    if (this.owners[cell] !== this.selfId) return false;
    const x = cell % this.w;
    if (x > 0 && this.owners[cell - 1] !== this.selfId) return false;
    if (x < this.w - 1 && this.owners[cell + 1] !== this.selfId) return false;
    if (cell >= this.w && this.owners[cell - this.w] !== this.selfId) return false;
    if (cell < this.cells - this.w && this.owners[cell + this.w] !== this.selfId) return false;
    return !this.buildings.some((b) => b.cell === cell);
  }

  // Порт: своя прибрежная клетка (рядом вода), без вражеских соседей, без здания
  canBuildPortAt(cell: number): boolean {
    if (cell < 0 || cell >= this.cells || !this.terrain[cell]) return false;
    if (this.owners[cell] !== this.selfId) return false;
    const x = cell % this.w;
    const y = (cell / this.w) | 0;
    let coastal = false;
    let enemyAdj = false;
    const chk = (n: number) => {
      if (!this.terrain[n]) coastal = true;
      else if (this.owners[n] !== this.selfId) enemyAdj = true;
    };
    if (x > 0) chk(cell - 1);
    if (x < this.w - 1) chk(cell + 1);
    if (y > 0) chk(cell - this.w);
    if (y < this.h - 1) chk(cell + this.w);
    if (!coastal || enemyAdj) return false;
    return !this.buildings.some((b) => b.cell === cell);
  }

  // ближайшая своя прибрежная клетка под порт в радиусе maxR (притягивание)
  nearestOwnCoast(cell: number, maxR: number): number {
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
        if (!this.canBuildPortAt(c)) continue;
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // своё здание типа type в радиусе PORT_RADIUS от клетки (клик туда апгрейдит)
  nearbyOwnType(cell: number, type: BuildingType): BuildingPub | undefined {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const r2 = PORT_RADIUS * PORT_RADIUS;
    return this.buildings.find(
      (b) =>
        b.type === type &&
        b.owner === this.selfId &&
        ((b.cell % this.w) - cx) ** 2 + (((b.cell / this.w) | 0) - cy) ** 2 <= r2
    );
  }

  nearbyPort(cell: number): BuildingPub | undefined {
    return this.nearbyOwnType(cell, 'port');
  }

  // есть ли рядом (радиус r) здание из types — для запрета/предпросмотра города
  buildingNear(cell: number, r: number, types: BuildingType[]): boolean {
    const cx = cell % this.w;
    const cy = (cell / this.w) | 0;
    const r2 = r * r;
    return this.buildings.some(
      (b) =>
        types.includes(b.type) &&
        ((b.cell % this.w) - cx) ** 2 + (((b.cell / this.w) | 0) - cy) ** 2 <= r2
    );
  }

  // можно ли поставить город: своя внутренняя клетка (как штаб) и рядом нет
  // никакого другого строения
  canBuildCityAt(cell: number): boolean {
    if (!this.canBuildAt(cell)) return false;
    return !this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port']);
  }

  // штаб: внутренняя клетка и рядом нет другого строения
  canBuildHqAt(cell: number): boolean {
    if (!this.canBuildAt(cell)) return false;
    return !this.buildingNear(cell, PORT_RADIUS, ['hq', 'city', 'port']);
  }

  // Центрируем камеру на клетке (фокус на агрессоре), с приближением
  focusOn(cx: number, cy: number) {
    this.anim = null;
    this.zoom = Math.max(this.zoom, this.minZoom() * 3, 5);
    this.panX = window.innerWidth / 2 - cx * this.zoom;
    this.panY = window.innerHeight / 2 - cy * this.zoom;
    this.clampPan();
  }

  // Плавный автозум к своей территории (вызывается при старте игры).
  // Возвращает true, если территория найдена и анимация запущена.
  focusSelfSmooth(): boolean {
    if (!this.w || this.selfId <= 0) return false;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let c = 0; c < this.cells; c++) {
      if (this.owners[c] === this.selfId) {
        sx += c % this.w;
        sy += (c / this.w) | 0;
        n++;
      }
    }
    if (!n) return false;
    const cx = sx / n;
    const cy = sy / n;
    // целевой зум: вплотную к своей территории (обзор ~70 клеток)
    const span = Math.min(window.innerWidth, window.innerHeight);
    const toZ = Math.max(this.minZoom(), Math.min(30, span / 70));
    const toX = window.innerWidth / 2 - cx * toZ;
    const toY = window.innerHeight / 2 - cy * toZ;
    this.anim = {
      t0: performance.now(),
      dur: 900,
      fromX: this.panX,
      fromY: this.panY,
      fromZ: this.zoom,
      toX,
      toY,
      toZ,
    };
    return true;
  }

  setAttacks(attacks: AttackPub[]) {
    this.attacks = attacks;
    const nw = new Set<number>();
    if (this.selfId > 0) {
      for (const a of attacks) {
        if (a.player === this.selfId && a.target > 0) nw.add(a.target);
        if (a.target === this.selfId) nw.add(a.player);
      }
    }
    const changed =
      nw.size !== this.warSet.size || [...nw].some((id) => !this.warSet.has(id));
    this.warSet = nw;
    if (changed) this.repaintAll(); // война началась/кончилась — перекрасить фронт
    // счётчики фронта пересчитываем редко и только когда они видны
    if (this.labelsVisible() && (changed || this.warTick++ % 10 === 0)) {
      this.computeWarLabels();
    }
  }

  // Точки у линии фронта, где рисуем выделенные войска
  private computeWarLabels() {
    this.warLabels = [];
    if (!this.warSet.size) return;
    const acc = new Map<number, { sx: number; sy: number; n: number }>();
    for (let c = 0; c < this.cells; c++) {
      const o = this.owners[c];
      if (!this.warSet.has(o) || !this.neighborIs(c, this.selfId)) continue;
      let a = acc.get(o);
      if (!a) {
        a = { sx: 0, sy: 0, n: 0 };
        acc.set(o, a);
      }
      a.sx += c % this.w;
      a.sy += (c / this.w) | 0;
      a.n++;
    }
    for (const [id, a] of acc) {
      const lines: string[] = [];
      const mine = this.attacks.find((x) => x.player === this.selfId && x.target === id);
      const theirs = this.attacks.find((x) => x.player === id && x.target === this.selfId);
      if (mine) lines.push(`⚔️ ${fmtTroops(mine.troops)}`);
      if (theirs) lines.push(`🛡 ${fmtTroops(theirs.troops)}`);
      if (lines.length) {
        this.warLabels.push({ x: a.sx / a.n + 0.5, y: a.sy / a.n + 0.5, lines });
      }
    }
  }

  private neighborIs(c: number, id: number): boolean {
    const x = c % this.w;
    return (
      (x > 0 && this.owners[c - 1] === id) ||
      (x < this.w - 1 && this.owners[c + 1] === id) ||
      (c >= this.w && this.owners[c - this.w] === id) ||
      (c < this.cells - this.w && this.owners[c + this.w] === id)
    );
  }

  private neighborInWar(c: number): boolean {
    const x = c % this.w;
    return (
      (x > 0 && this.warSet.has(this.owners[c - 1])) ||
      (x < this.w - 1 && this.warSet.has(this.owners[c + 1])) ||
      (c >= this.w && this.warSet.has(this.owners[c - this.w])) ||
      (c < this.cells - this.w && this.warSet.has(this.owners[c + this.w]))
    );
  }

  private repaintAll() {
    for (let c = 0; c < this.cells; c++) this.paint(c);
    this.dirty = true;
  }

  private paint(c: number) {
    if (!this.img) return;
    const d = this.img.data;
    const i = c * 4;
    let r: number, g: number, b: number;
    if (!this.terrain[c]) {
      [r, g, b] = WATER;
    } else {
      const o = this.owners[c];
      if (o === 0) {
        r = this.neutralRGB[c * 3];
        g = this.neutralRGB[c * 3 + 1];
        b = this.neutralRGB[c * 3 + 2];
      } else if (this.isBorder(c, o) && this.fortField[c] === o) {
        // укреплённая штабом граница — камень; приоритет даже под атакой,
        // чтобы было видно, что щит работает
        [r, g, b] = FORT_BORDER;
      } else if (o === this.selfId && this.warSet.size && this.neighborInWar(c)) {
        [r, g, b] = WAR; // наша сторона фронта
      } else if (this.warSet.has(o) && this.neighborIs(c, this.selfId)) {
        [r, g, b] = WAR; // сторона противника
      } else {
        // владение полупрозрачно поверх рельефа: цвет игрока смешиваем с биомом
        // клетки (neutralRGB), чтобы был виден рельеф карты. Граница — темнее.
        const [pr, pg, pb] = playerColorRGB(o);
        const k = this.isBorder(c, o) ? 0.55 : 1; // затемнение границы
        const tr = this.neutralRGB[c * 3];
        const tg = this.neutralRGB[c * 3 + 1];
        const tb = this.neutralRGB[c * 3 + 2];
        const A = 0.68; // доля цвета игрока (остальное — рельеф)
        r = (pr * k * A + tr * (1 - A)) | 0;
        g = (pg * k * A + tg * (1 - A)) | 0;
        b = (pb * k * A + tb * (1 - A)) | 0;
      }
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }

  private isBorder(c: number, o: number): boolean {
    const x = c % this.w;
    return (
      (x > 0 && this.owners[c - 1] !== o) ||
      (x < this.w - 1 && this.owners[c + 1] !== o) ||
      (c >= this.w && this.owners[c - this.w] !== o) ||
      (c < this.cells - this.w && this.owners[c + this.w] !== o)
    );
  }

  // Минимальный зум: вся карта целиком с запасом вокруг — удобно осматривать
  private minZoom() {
    if (!this.w) return 1;
    return Math.min(window.innerWidth / this.w, window.innerHeight / this.h) * 0.8;
  }

  // Метки видны, когда приблизились вдвое от обзорного (минимального) зума
  private labelsVisible() {
    return this.zoom >= this.minZoom() * LABEL_ZOOM_MUL;
  }

  // Стартовый вид: максимальный обзор всей карты с запасом (для выбора спавна)
  private fitView() {
    if (!this.w) return;
    const z = this.minZoom();
    this.zoom = z;
    this.panX = (window.innerWidth - this.w * z) / 2;
    this.panY = (window.innerHeight - this.h * z) / 2;
  }

  // Ограничение панорамы. Разрешаем «перелёт» за края карты на margin пикселей,
  // чтобы можно было вытащить края/углы из-под HUD и спокойно их рассмотреть.
  private clampPan() {
    if (!this.w) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const mw = this.w * this.zoom;
    const mh = this.h * this.zoom;
    const margin = Math.min(w, h) * 0.5;
    if (mw <= w) {
      const c = (w - mw) / 2; // карта уже вся видна — но даём чуть подвигать
      this.panX = Math.min(c + margin, Math.max(c - margin, this.panX));
    } else {
      this.panX = Math.min(margin, Math.max(w - mw - margin, this.panX));
    }
    if (mh <= h) {
      const c = (h - mh) / 2;
      this.panY = Math.min(c + margin, Math.max(c - margin, this.panY));
    } else {
      this.panY = Math.min(margin, Math.max(h - mh - margin, this.panY));
    }
  }

  // Имена игроков поверх их территорий (в экранных координатах)
  private drawNames(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // при отдалении названия стран и счётчики скрыты — рисуем только лодки
    const showLabels = this.labelsVisible();
    const foodZoom = this.minZoom() * FOOD_LABEL_MUL;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (showLabels)
    for (const p of this.players) {
      if (!p.alive || p.cells === 0) continue;
      // корм подписываем лишь когда он огромен или карта сильно приближена
      const isFood = p.bot && !p.strong;
      if (isFood && p.cells < FOOD_LABEL_CELLS && this.zoom < foodZoom) continue;
      const l = this.labels.get(p.id);
      if (!l) continue;
      let size = Math.sqrt(p.cells) * this.zoom * 0.22;
      if (p.id === this.selfId) size = Math.max(size, 10);
      if (size < 8) continue; // слишком мелко — не захламляем карту
      size = Math.min(size, 26);
      const sx = this.panX + l.x * this.zoom;
      const sy = this.panY + l.y * this.zoom;
      // отсекаем подписи за пределами экрана — не тратим strokeText впустую
      if (sx < -80 || sy < -40 || sx > vw + 80 || sy > vh + 40) continue;
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${size}px 'IBM Plex Sans', -apple-system, sans-serif`;
      ctx.strokeText(p.name, sx, sy);
      ctx.fillText(p.name, sx, sy);
      if (size > 11) {
        const troops = fmtTroops(p.troops);
        const ty = sy + size * 0.95;
        ctx.font = `600 ${size * 0.72}px 'IBM Plex Mono', monospace`;
        ctx.strokeText(troops, sx, ty);
        ctx.fillText(troops, sx, ty);
      }
    }
    // союзники: зелёное рукопожатие в центре территории
    if (this.allies.size) {
      for (const id of this.allies) {
        const l = this.labels.get(id);
        if (!l) continue;
        const sx = this.panX + l.x * this.zoom;
        const sy = this.panY + l.y * this.zoom;
        if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue;
        const size = Math.min(28, Math.max(14, this.zoom * 3));
        ctx.font = `${size}px sans-serif`;
        ctx.fillText('🤝', sx, sy - size * 1.4);
      }
    }
    // морские десанты: след повторяет маршрут (строго по воде), позицию
    // интерполируем между апдейтами, лодку слегка покачиваем по времени
    const now = performance.now();
    for (const b of this.boats) {
      const pts = b.path.length / 2;
      if (pts < 2) continue;
      const col = playerColorCSS(b.player);
      const hostile = b.target === this.selfId;
      let cached = this.boatCum.get(b.id);
      if (!cached || cached.len !== b.path.length) {
        cached = this.buildBoatPath(b.path, pts);
        this.boatCum.set(b.id, cached);
      }
      const { cum, total, wob } = cached;
      // плавная интерполяция прогресса (сервер шлёт ~10 раз/с, экран 60fps)
      let shown = this.boatProg.get(b.id);
      shown = shown === undefined ? b.prog : shown + (b.prog - shown) * 0.25;
      this.boatProg.set(b.id, shown);
      const done = Math.max(0, Math.min(1, shown)) * total;
      const px = this.panX;
      const py = this.panY;
      const z = this.zoom;
      // трасер: сплошная линия по кэшированным точкам до текущей дистанции
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = hostile ? 'rgba(255,77,51,0.85)' : col;
      ctx.beginPath();
      ctx.moveTo(px + wob[0] * z, py + wob[1] * z);
      let i = 1;
      for (; i < pts && cum[i] <= done; i++) ctx.lineTo(px + wob[i * 2] * z, py + wob[i * 2 + 1] * z);
      // конечная точка на дистанции done (интерполяция сегмента) = позиция лодки
      const s = Math.min(i, pts - 1);
      const segLen = cum[s] - cum[s - 1] || 1;
      const t = Math.max(0, Math.min(1, (done - cum[s - 1]) / segLen));
      const wx = wob[(s - 1) * 2] + (wob[s * 2] - wob[(s - 1) * 2]) * t;
      const wy = wob[(s - 1) * 2 + 1] + (wob[s * 2 + 1] - wob[(s - 1) * 2 + 1]) * t;
      const bx = px + wx * z;
      const by = py + wy * z;
      ctx.lineTo(bx, by);
      ctx.stroke();
      const rad = Math.max(5, Math.min(11, this.zoom * 1.6));
      // лёгкое плавное покачивание самой лодки на волнах (по времени, не по маршруту)
      const bob = Math.sin(now * 0.0035 + b.id * 1.7) * Math.min(2.5, rad * 0.22);
      const cyb = by + bob;
      ctx.beginPath();
      ctx.arc(bx, cyb, rad, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hostile ? '#ff4d33' : 'rgba(0,0,0,0.6)';
      ctx.stroke();
      const label = fmtTroops(b.troops);
      const fs = Math.max(10, rad * 1.3);
      ctx.font = `700 ${fs}px 'IBM Plex Mono', monospace`;
      ctx.lineWidth = Math.max(2, fs / 5);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = '#fff';
      ctx.strokeText(label, bx, cyb - rad - fs * 0.7);
      ctx.fillText(label, bx, cyb - rad - fs * 0.7);
    }

    // выделенные войска у линии фронта — тоже скрыты при отдалении
    if (showLabels)
    for (const wl of this.warLabels) {
      const size = Math.min(16, Math.max(11, this.zoom * 3));
      const sx = this.panX + wl.x * this.zoom;
      let sy = this.panY + wl.y * this.zoom;
      if (sx < -80 || sy < -40 || sx > vw + 80 || sy > vh + 40) continue;
      ctx.font = `700 ${size}px 'IBM Plex Mono', monospace`;
      ctx.lineWidth = Math.max(2.5, size / 5);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#ff6a55';
      for (const line of wl.lines) {
        ctx.strokeText(line, sx, sy);
        ctx.fillText(line, sx, sy);
        sy += size * 1.15;
      }
    }
  }


  // Иконка через кэш-спрайт: эмодзи рисуется один раз в маленький canvas, дальше
  // дешёвый drawImage. Критично при сотнях зданий на экране (иначе fillText-эмодзи
  // каждый кадр роняет FPS). Внешне идентично прежнему fillText.
  private drawEmoji(ctx: CanvasRenderingContext2D, emoji: string, cx: number, cy: number, fontPx: number) {
    let s = this.emojiCache.get(emoji);
    if (!s) {
      const S = 64;
      s = document.createElement('canvas');
      s.width = S;
      s.height = S;
      const c = s.getContext('2d')!;
      c.font = `${Math.round(S * 0.82)}px sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(emoji, S / 2, S / 2 + S * 0.06);
      this.emojiCache.set(emoji, s);
    }
    const d = fontPx / 0.82; // видимый размер эмодзи ≈ fontPx (как у прежнего font)
    ctx.drawImage(s, cx - d / 2, cy + 1 - d / 2, d, d);
  }

  // Здания на карте + предпросмотр в режиме постройки (зелёный/серый)
  private drawBuildings(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const r = Math.max(5, Math.min(16, this.zoom * 2.2));
    const badge = r >= 9; // мелкие цифры-бейджи при отдалении не читаются — не рисуем
    const now = performance.now();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const b of this.buildings) {
      const sx = this.panX + (b.cell % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((b.cell / this.w | 0) + 0.5) * this.zoom;
      if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue; // вне экрана
      if (b.type === 'silo') {
        const buildingP = b.progress < 1;
        const upgrading = b.upProgress > 0 && b.upProgress < 1;
        ctx.globalAlpha = buildingP ? 0.55 : 1;
        ctx.fillStyle = '#2a0f0f';
        ctx.strokeStyle = playerColorCSS(b.owner);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        this.drawEmoji(ctx, '🚀', sx, sy, r * 1.1);
        // заряд/залп справа-сверху (напр. 2/3) — только достроенная и не мелко
        if (badge && !buildingP) {
          const fs = Math.max(9, r * 0.85);
          ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
          ctx.lineWidth = Math.max(2, fs / 5);
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.fillStyle = b.ammo > 0 ? '#ffd27a' : '#ff6a55';
          const txt = `${b.ammo}/${b.level}`;
          ctx.strokeText(txt, sx + r, sy - r);
          ctx.fillText(txt, sx + r, sy - r);
        }
        ctx.globalAlpha = 1;
        if (buildingP || upgrading) {
          const prog = buildingP ? b.progress : b.upProgress;
          const bw = r * 2.4;
          const bh = Math.max(3, r * 0.35);
          const bx = sx - bw / 2;
          const by = sy - r - bh - 3;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = buildingP ? '#ff7a2a' : '#4dd2ff';
          ctx.fillRect(bx, by, bw * prog, bh);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
        }
        continue;
      }
      if (b.type === 'sam') {
        const buildingP = b.progress < 1;
        const upgrading = b.upProgress > 0 && b.upProgress < 1;
        ctx.globalAlpha = buildingP ? 0.55 : 1;
        ctx.fillStyle = '#0b1f2a';
        ctx.strokeStyle = '#4de1ff'; // бирюзовый — ПВО
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        this.drawEmoji(ctx, '🛰️', sx, sy, r * 1.05);
        if (badge && !buildingP) {
          const fs = Math.max(9, r * 0.85);
          ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
          ctx.lineWidth = Math.max(2, fs / 5);
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.fillStyle = b.ammo > 0 ? '#8fe9f2' : '#ff6a55';
          const txt = `${b.ammo}/${b.level}`;
          ctx.strokeText(txt, sx + r, sy - r);
          ctx.fillText(txt, sx + r, sy - r);
        }
        ctx.globalAlpha = 1;
        if (buildingP || upgrading) {
          const prog = buildingP ? b.progress : b.upProgress;
          const bw = r * 2.4;
          const bh = Math.max(3, r * 0.35);
          const bx = sx - bw / 2;
          const by = sy - r - bh - 3;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = buildingP ? '#4de1ff' : '#4dd2ff';
          ctx.fillRect(bx, by, bw * prog, bh);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
        }
        continue;
      }
      if (b.type === 'factory') {
        const buildingP = b.progress < 1;
        ctx.globalAlpha = buildingP ? 0.55 : 1;
        ctx.fillStyle = '#2a2412';
        ctx.strokeStyle = playerColorCSS(b.owner);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        this.drawEmoji(ctx, '🏭', sx, sy, r * 1.1);
        if (badge && b.level > 1 && !buildingP) {
          const fs = Math.max(10, r * 0.9);
          ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
          ctx.lineWidth = Math.max(2, fs / 5);
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.fillStyle = '#ffd27a';
          ctx.strokeText(String(b.level), sx + r, sy - r);
          ctx.fillText(String(b.level), sx + r, sy - r);
        }
        ctx.globalAlpha = 1;
        if (buildingP) {
          const bw = r * 2.4, bh = Math.max(3, r * 0.35);
          const bx = sx - bw / 2, by = sy - r - bh - 3;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = '#ffb84d';
          ctx.fillRect(bx, by, bw * b.progress, bh);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
        }
        continue;
      }
      if (b.type === 'city') {
        const buildingP = b.progress < 1;
        ctx.globalAlpha = buildingP ? 0.55 : 1;
        ctx.fillStyle = '#241a10';
        ctx.strokeStyle = playerColorCSS(b.owner); // цвет владельца (переходит при захвате)
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        this.drawEmoji(ctx, '🏙️', sx, sy, r * 1.1);
        if (badge && b.level > 1 && !buildingP) {
          const fs = Math.max(10, r * 0.9);
          ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
          ctx.lineWidth = Math.max(2, fs / 5);
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.fillStyle = '#ffd27a';
          ctx.strokeText(String(b.level), sx + r, sy - r);
          ctx.fillText(String(b.level), sx + r, sy - r);
        }
        ctx.globalAlpha = 1;
        if (buildingP) {
          const bw = r * 2.4;
          const bh = Math.max(3, r * 0.35);
          const bx = sx - bw / 2;
          const by = sy - r - bh - 3;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = '#ffd27a';
          ctx.fillRect(bx, by, bw * b.progress, bh);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
        }
        continue;
      }
      if (b.type === 'port') {
        const buildingP = b.progress < 1;
        ctx.globalAlpha = buildingP ? 0.55 : 1;
        ctx.fillStyle = '#0b2a2e';
        ctx.strokeStyle = '#37c7d4'; // бирюзовый — порт
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        this.drawEmoji(ctx, '⚓', sx, sy, r * 1.1);
        // номер уровня справа-сверху
        if (badge && b.level > 1 && !buildingP) {
          const fs = Math.max(10, r * 0.9);
          ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
          ctx.lineWidth = Math.max(2, fs / 5);
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.fillStyle = '#8fe9f2';
          ctx.strokeText(String(b.level), sx + r, sy - r);
          ctx.fillText(String(b.level), sx + r, sy - r);
        }
        ctx.globalAlpha = 1;
        // прогресс постройки над портом (апгрейд мгновенный — бар не нужен)
        if (buildingP) {
          const bw = r * 2.4;
          const bh = Math.max(3, r * 0.35);
          const bx = sx - bw / 2;
          const by = sy - r - bh - 3;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = '#37c7d4';
          ctx.fillRect(bx, by, bw * b.progress, bh);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
        }
        continue;
      }
      const building = b.progress < 1;
      const upgrading = b.upProgress > 0 && b.upProgress < 1;
      ctx.globalAlpha = building ? 0.55 : 1; // строящийся — приглушён
      ctx.fillStyle = '#0e1a2b';
      // цвет обводки по уровню: 1 — свой цвет, 2 — золото, 3 — оранжево-красный
      ctx.strokeStyle = b.level >= 3 ? '#ff7a2a' : b.level >= 2 ? '#f2c94c' : playerColorCSS(b.owner);
      ctx.lineWidth = b.level >= 2 ? 3 : 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // у 3-го уровня — двойное кольцо
      if (b.level >= 3) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.drawEmoji(ctx, b.level >= 2 ? '🛡️' : '🛡', sx, sy, r * 1.2);
      ctx.globalAlpha = 1;
      // прогресс-бар постройки/апгрейда над зданием
      if (building || upgrading) {
        const prog = building ? b.progress : b.upProgress;
        const bw = r * 2.4;
        const bh = Math.max(3, r * 0.35);
        const bx = sx - bw / 2;
        const by = sy - r - bh - 3 - (b.level >= 3 ? 3 : 0);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = building ? '#f2c94c' : '#4dd2ff'; // апгрейд — голубой
        ctx.fillRect(bx, by, bw * prog, bh);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, bh);
      } else if (b.fuse > 0) {
        // захвачен прокачанный — красный пульсирующий фитиль с таймером
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.012);
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.strokeStyle = '#ff3b2f';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const fs = Math.max(11, r);
        ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
        ctx.lineWidth = Math.max(2, fs / 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#ff6a55';
        ctx.strokeText(Math.ceil(b.fuse) + 'с', sx, sy - r - fs * 0.7);
        ctx.fillText(Math.ceil(b.fuse) + 'с', sx, sy - r - fs * 0.7);
      }
    }
    // вспышки взрыва (расширяющийся круг). Ядерка — крупнее и дольше.
    this.flashes = this.flashes.filter((f) => now - f.t0 < (f.nuke ? 1000 : 600));
    for (const f of this.flashes) {
      const dur = f.nuke ? 1000 : 600;
      const p = (now - f.t0) / dur;
      const sx = this.panX + (f.cell % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((f.cell / this.w | 0) + 0.5) * this.zoom;
      const cellsR = f.nuke ? HQ_EXPLODE_RADIUS * 2 : f.big ? HQ_EXPLODE_RADIUS : r / this.zoom + 2;
      const maxR = cellsR * this.zoom;
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.beginPath();
      ctx.arc(sx, sy, maxR * (0.3 + p * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = f.nuke ? 'rgba(255,90,20,0.55)' : f.big ? 'rgba(255,120,40,0.5)' : 'rgba(255,180,60,0.5)';
      ctx.fill();
      ctx.lineWidth = f.nuke ? 5 : 3;
      ctx.strokeStyle = f.nuke ? '#ffdd55' : '#ff8a2a';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // всплывающий заработок портов: зелёное «+сумма» поднимается и тает (~1.4с)
    const POP_MS = 1400;
    this.moneyPops = this.moneyPops.filter((m) => now - m.t0 < POP_MS);
    ctx.textAlign = 'center';
    for (const m of this.moneyPops) {
      const p = (now - m.t0) / POP_MS;
      const sx = this.panX + m.x * this.zoom;
      const sy = this.panY + m.y * this.zoom - r - 6 - p * 26;
      if (sx < -60 || sy < -20 || sx > vw + 60 || sy > vh + 20) continue;
      const fs = Math.max(12, Math.min(20, this.zoom * 2.4));
      ctx.globalAlpha = 1 - p * p; // держится, потом быстро гаснет
      ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
      ctx.lineWidth = Math.max(2.5, fs / 5);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#57e08a';
      const txt = '+' + fmtMoney(m.amount);
      ctx.strokeText(txt, sx, sy);
      ctx.fillText(txt, sx, sy);
      ctx.globalAlpha = 1;
    }
    // предпросмотр порта под курсором (притягивается к берегу)
    if (this.buildMode === 'port' && this.hoverCell >= 0) {
      const near = this.nearbyPort(this.hoverCell);
      // куда реально встанет порт: апгрейд существующего, либо ближайший берег
      const target = near
        ? near.cell
        : this.canBuildPortAt(this.hoverCell)
          ? this.hoverCell
          : this.nearestOwnCoast(this.hoverCell, PORT_RADIUS);
      const cellFor = target >= 0 ? target : this.hoverCell;
      const sx = this.panX + (cellFor % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((cellFor / this.w | 0) + 0.5) * this.zoom;
      const ok = target >= 0;
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = ok ? 'rgba(55,199,212,0.35)' : 'rgba(120,120,120,0.4)';
      ctx.strokeStyle = ok ? '#37c7d4' : '#8a8a8a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${r * 1.1}px sans-serif`;
      ctx.fillText('⚓', sx, sy + 1);
      // при апгрейде — показываем будущий уровень
      if (near) {
        const fs = Math.max(10, r * 0.9);
        ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
        ctx.lineWidth = Math.max(2, fs / 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#8fe9f2';
        ctx.strokeText('→' + (near.level + 1), sx + r, sy - r);
        ctx.fillText('→' + (near.level + 1), sx + r, sy - r);
      }
      ctx.globalAlpha = 1;
    } else if (this.buildMode === 'city' && this.hoverCell >= 0) {
      // предпросмотр города: апгрейд существующего или новый (радиус запрета)
      const near = this.nearbyOwnType(this.hoverCell, 'city');
      const cellFor = near ? near.cell : this.hoverCell;
      const ok = near ? true : this.canBuildCityAt(this.hoverCell);
      const sx = this.panX + (cellFor % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((cellFor / this.w | 0) + 0.5) * this.zoom;
      // зона запрета застройки рядом (радиус PORT_RADIUS)
      const rangePx = PORT_RADIUS * this.zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, rangePx, 0, Math.PI * 2);
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = ok ? 'rgba(255,210,122,0.7)' : 'rgba(160,160,160,0.6)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = ok ? 'rgba(255,210,122,0.3)' : 'rgba(120,120,120,0.4)';
      ctx.strokeStyle = ok ? '#ffd27a' : '#8a8a8a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${r * 1.1}px sans-serif`;
      ctx.fillText('🏙️', sx, sy + 1);
      if (near) {
        const fs = Math.max(10, r * 0.9);
        ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
        ctx.lineWidth = Math.max(2, fs / 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#ffd27a';
        ctx.strokeText('→' + (near.level + 1), sx + r, sy - r);
        ctx.fillText('→' + (near.level + 1), sx + r, sy - r);
      }
      ctx.globalAlpha = 1;
    } else if (this.buildMode === 'factory' && this.hoverCell >= 0) {
      // предпросмотр завода: показываем ЗОНУ ОХВАТА (радиус связывания дорог/усиления)
      const near = this.nearbyOwnType(this.hoverCell, 'factory');
      const cellFor = near ? near.cell : this.hoverCell;
      const ok = near ? true : this.canBuildCityAt(this.hoverCell);
      const sx = this.panX + (cellFor % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((cellFor / this.w | 0) + 0.5) * this.zoom;
      const rangePx = FACTORY_RANGE * this.zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, rangePx, 0, Math.PI * 2);
      ctx.fillStyle = ok ? 'rgba(255,184,77,0.10)' : 'rgba(150,150,150,0.15)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = ok ? 'rgba(255,184,77,0.85)' : 'rgba(160,160,160,0.7)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = ok ? 'rgba(42,36,18,0.9)' : 'rgba(120,120,120,0.4)';
      ctx.strokeStyle = ok ? '#ffb84d' : '#8a8a8a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${r * 1.1}px sans-serif`;
      ctx.globalAlpha = ok ? 1 : 0.5;
      ctx.fillText('🏭', sx, sy + 1);
      if (near) {
        const fs = Math.max(10, r * 0.9);
        ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
        ctx.lineWidth = Math.max(2, fs / 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#ffd27a';
        ctx.strokeText('→' + (near.level + 1), sx + r, sy - r);
        ctx.fillText('→' + (near.level + 1), sx + r, sy - r);
      }
      ctx.globalAlpha = 1;
    } else if (this.buildMode === 'sam' && this.hoverCell >= 0) {
      // предпросмотр ПВО: показываем ЗОНУ ПОКРЫТИЯ (радиус перехвата SAM_RANGE)
      const near = this.nearbyOwnType(this.hoverCell, 'sam');
      const cellFor = near ? near.cell : this.hoverCell;
      const ok = near ? true : this.canBuildHqAt(this.hoverCell);
      const sx = this.panX + (cellFor % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((cellFor / this.w | 0) + 0.5) * this.zoom;
      const rangePx = SAM_RANGE * this.zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, rangePx, 0, Math.PI * 2);
      ctx.fillStyle = ok ? 'rgba(77,225,255,0.12)' : 'rgba(150,150,150,0.15)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = ok ? 'rgba(77,225,255,0.8)' : 'rgba(160,160,160,0.7)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = ok ? 'rgba(11,31,42,0.9)' : 'rgba(120,120,120,0.4)';
      ctx.strokeStyle = ok ? '#4de1ff' : '#8a8a8a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${r * 1.05}px sans-serif`;
      ctx.globalAlpha = ok ? 1 : 0.5;
      ctx.fillText('🛰️', sx, sy + 1);
      if (near) {
        const fs = Math.max(10, r * 0.9);
        ctx.font = `800 ${fs}px 'IBM Plex Mono', monospace`;
        ctx.lineWidth = Math.max(2, fs / 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = '#8fe9f2';
        ctx.strokeText('→' + (near.level + 1), sx + r, sy - r);
        ctx.fillText('→' + (near.level + 1), sx + r, sy - r);
      }
      ctx.globalAlpha = 1;
    } else if (this.buildMode && this.hoverCell >= 0) {
      // предпросмотр штаба
      const ok = this.canBuildHqAt(this.hoverCell);
      const sx = this.panX + (this.hoverCell % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((this.hoverCell / this.w | 0) + 0.5) * this.zoom;
      // зона покрытия штаба — полупрозрачная плёнка радиуса HQ_RADIUS
      const rangePx = HQ_RADIUS * this.zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, rangePx, 0, Math.PI * 2);
      ctx.fillStyle = ok ? 'rgba(110,224,138,0.18)' : 'rgba(150,150,150,0.18)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = ok ? 'rgba(110,224,138,0.8)' : 'rgba(160,160,160,0.7)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = ok ? 'rgba(120,220,140,0.35)' : 'rgba(120,120,120,0.4)';
      ctx.strokeStyle = ok ? '#6ee08a' : '#8a8a8a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${r * 1.2}px sans-serif`;
      ctx.globalAlpha = ok ? 1 : 0.5;
      ctx.fillText('🛡', sx, sy + 1);
      ctx.globalAlpha = 1;
    }
    // при наведении ядерки — красные полупрозрачные зоны ВСЕХ ПВО (там ракету собьют)
    if (this.nukeKind) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rr = SAM_RANGE * this.zoom;
      for (const b of this.buildings) {
        if (b.type !== 'sam' || b.progress < 1) continue;
        const sx = this.panX + (b.cell % this.w + 0.5) * this.zoom;
        const sy = this.panY + ((b.cell / this.w | 0) + 0.5) * this.zoom;
        if (sx < -rr || sy < -rr || sx > vw + rr || sy > vh + rr) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,40,40,0.12)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,60,60,0.6)';
        ctx.stroke();
      }
    }
    // наведение ядерного удара: прицел + радиус поражения выбранной ракеты
    if (this.nukeKind && this.hoverCell >= 0) {
      const sx = this.panX + (this.hoverCell % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((this.hoverCell / this.w | 0) + 0.5) * this.zoom;
      const blast = (NUKES[this.nukeKind]?.radius ?? NUKES.basic.radius) * this.zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, blast, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,60,30,0.18)';
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,80,40,0.9)';
      ctx.stroke();
      ctx.setLineDash([]);
      // перекрестие
      const cr = Math.max(8, this.zoom * 3);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ff4d22';
      ctx.beginPath();
      ctx.moveTo(sx - cr, sy);
      ctx.lineTo(sx + cr, sy);
      ctx.moveTo(sx, sy - cr);
      ctx.lineTo(sx, sy + cr);
      ctx.stroke();
    }
  }

  // Миникарта пониженного разрешения (≤300px) — иначе копирование полного
  // битмапа карты (до 1920×900) каждый кадр съедает FPS.
  private sizeMinimap() {
    if (!this.miniCanvas || !this.w) return;
    const MINI_W = 300;
    this.miniScale = Math.min(1, MINI_W / this.w);
    this.miniCanvas.width = Math.max(1, Math.round(this.w * this.miniScale));
    this.miniCanvas.height = Math.max(1, Math.round(this.h * this.miniScale));
    this.miniCanvas.style.aspectRatio = `${this.w} / ${this.h}`;
    this.miniPanX = NaN; // форсируем перерисовку
  }

  // mapChanged — битмап карты изменился в этом кадре. Перерисовываем миникарту
  // только когда изменилась карта ИЛИ подвинулась камера (не каждый кадр).
  private drawMinimap(mapChanged: boolean) {
    const mc = this.miniCtx;
    if (!mc || !this.w) return;
    const moved = this.panX !== this.miniPanX || this.panY !== this.miniPanY || this.zoom !== this.miniZoom;
    if (!mapChanged && !moved) return;
    this.miniPanX = this.panX;
    this.miniPanY = this.panY;
    this.miniZoom = this.zoom;
    const mw = this.miniCanvas!.width;
    const mh = this.miniCanvas!.height;
    const s = this.miniScale;
    mc.drawImage(this.off, 0, 0, mw, mh); // даунскейл всей карты за одну операцию
    // рамка видимой области (в координатах миникарты)
    mc.strokeStyle = 'rgba(15,20,30,0.9)';
    mc.lineWidth = Math.max(1, 2);
    mc.strokeRect(
      (-this.panX / this.zoom) * s,
      (-this.panY / this.zoom) * s,
      (window.innerWidth / this.zoom) * s,
      (window.innerHeight / this.zoom) * s
    );
  }

  attachMinimap(canvas: HTMLCanvasElement): () => void {
    this.miniCanvas = canvas;
    this.miniCtx = canvas.getContext('2d');
    this.sizeMinimap();
    const toCenter = (e: PointerEvent) => {
      if (!this.w) return;
      const r = canvas.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * this.w;
      const my = ((e.clientY - r.top) / r.height) * this.h;
      this.panX = window.innerWidth / 2 - mx * this.zoom;
      this.panY = window.innerHeight / 2 - my * this.zoom;
      this.clampPan();
    };
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      toCenter(e);
    };
    const onMove = (e: PointerEvent) => {
      if (dragging) toCenter(e);
    };
    const onUp = () => {
      dragging = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      this.miniCanvas = null;
      this.miniCtx = null;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
    };
  }

  attach(canvas: HTMLCanvasElement): () => void {
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let down: { x: number; y: number } | null = null;
    let panning = false;
    // движение камеры на WASD (плавно, в цикле по зажатым клавишам)
    const heldKeys = new Set<string>();
    // используем e.code (физическая клавиша) — не зависит от раскладки: на русской
    // раскладке WASD дают ц/ф/ы/в, но code остаётся KeyW/KeyA/KeyS/KeyD
    const PAN_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // не мешаем вводу
      if (PAN_CODES.has(e.code)) { heldKeys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); }
    };
    const onKeyUp = (e: KeyboardEvent) => heldKeys.delete(e.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      if (this.zoom < this.minZoom()) this.fitView();
      else this.clampPan();
    };
    resize();
    window.addEventListener('resize', resize);
    this.fitView();

    let frames = 0;
    let lastFps = performance.now();
    const loop = () => {
      // замер FPS раз в ~0.5с
      frames++;
      const t = performance.now();
      if (t - lastFps >= 500) {
        this.fps = Math.round((frames * 1000) / (t - lastFps));
        frames = 0;
        lastFps = t;
      }
      // плавный автозум камеры
      if (this.anim) {
        const p = Math.min(1, (t - this.anim.t0) / this.anim.dur);
        const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
        this.zoom = this.anim.fromZ + (this.anim.toZ - this.anim.fromZ) * e;
        this.panX = this.anim.fromX + (this.anim.toX - this.anim.fromX) * e;
        this.panY = this.anim.fromY + (this.anim.toY - this.anim.fromY) * e;
        this.clampPan();
        if (p >= 1) this.anim = null;
      }
      // камера на WASD
      if (this.active && heldKeys.size) {
        const step = 16;
        if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp')) this.panY += step;
        if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown')) this.panY -= step;
        if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft')) this.panX += step;
        if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) this.panX -= step;
        this.anim = null; // ручное управление отменяет автозум
        this.clampPan();
      }
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (this.active && this.w && this.img) {
        const mapChanged = this.dirty;
        if (this.dirty) {
          this.offCtx.putImageData(this.img, 0, 0);
          this.dirty = false;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(this.panX, this.panY);
        ctx.scale(this.zoom, this.zoom);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.off, 0, 0);
        this.drawNames(ctx, dpr);
        drawShips(this, ctx, dpr);
        this.drawRoads(ctx, dpr);
        this.drawBuildings(ctx, dpr);
        drawFleet(this, ctx, dpr);
        drawMissiles(this, ctx, dpr);
        this.drawMinimap(mapChanged);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    let selecting = false; // тянем рамку выделения кораблей (Shift+drag)
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return; // правый клик — контекстное меню, не пан/атака
      this.anim = null; // пользователь взял управление — стоп автозум
      down = { x: e.clientX, y: e.clientY };
      panning = false;
      selecting = e.shiftKey; // Shift — выделение своих кораблей рамкой
      if (selecting) this.selBox = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    // правый клик / два пальца на тачпаде → морское вторжение
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      if (!this.w) return;
      const cx = Math.floor((e.clientX - this.panX) / this.zoom);
      const cy = Math.floor((e.clientY - this.panY) / this.zoom);
      if (cx >= 0 && cy >= 0 && cx < this.w && cy < this.h) {
        this.onCellRightClick?.(cy * this.w + cx, e.clientX, e.clientY);
      }
    };
    const cellUnder = (e: { clientX: number; clientY: number }) => {
      const cx = Math.floor((e.clientX - this.panX) / this.zoom);
      const cy = Math.floor((e.clientY - this.panY) / this.zoom);
      if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
      return cy * this.w + cx;
    };
    const onMove = (e: PointerEvent) => {
      if (this.buildMode || this.nukeKind || this.fleetMode) this.hoverCell = cellUnder(e); // предпросмотр
      if (!down) return;
      if (selecting && this.selBox) {
        this.selBox.x1 = e.clientX;
        this.selBox.y1 = e.clientY;
        return; // при выделении карту не тянем
      }
      if (panning || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
        panning = true;
        this.panX += e.movementX;
        this.panY += e.movementY;
        this.clampPan();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (selecting && this.selBox) {
        const b = this.selBox;
        const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
        const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
        const tiny = x1 - x0 < 5 && y1 - y0 < 5;
        if (tiny) {
          // Shift+клик по кораблю — добавить/убрать из выделения
          const id = this.myWarshipUnder(e.clientX, e.clientY);
          if (id >= 0) {
            if (this.selectedWarships.has(id)) this.selectedWarships.delete(id);
            else this.selectedWarships.add(id);
          }
        } else {
          // Shift+рамка — добавить корабли в рамке к выделению
          for (const wship of this.warships) {
            if (wship.owner !== this.selfId) continue;
            const sx = this.panX + wship.x * this.zoom;
            const sy = this.panY + wship.y * this.zoom;
            if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) this.selectedWarships.add(wship.id);
          }
        }
        this.selBox = null;
        selecting = false;
        down = null;
        panning = false;
        return;
      }
      if (down && !panning && this.w) {
        // обычный клик по своему кораблю — выделить его одного
        const id = this.myWarshipUnder(e.clientX, e.clientY);
        if (id >= 0) {
          this.selectedWarships.clear();
          this.selectedWarships.add(id);
        } else {
          const cell = cellUnder(e);
          if (cell >= 0) {
            if (this.buildMode) this.onBuild?.(cell); // ставим здание
            else if (this.selectedWarships.size && !this.nukeKind && !this.fleetMode && !this.terrain[cell]) {
              // корабли выделены + клик по ВОДЕ = приказ флоту идти туда
              this.onFleetMove?.(cell);
            } else {
              // клик по суше/территории (или без выделения) — сбрасываем флот и обычное действие (атака)
              if (this.selectedWarships.size) this.selectedWarships.clear();
              this.onCellClick?.(cell, e.clientX, e.clientY);
            }
          }
        }
      }
      down = null;
      panning = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.anim = null; // ручной зум отменяет автозум
      const k = Math.exp(-e.deltaY * 0.0036); // чувствительность зума ×3
      const nz = Math.min(60, Math.max(this.minZoom(), this.zoom * k));
      const kk = nz / this.zoom;
      this.panX = e.clientX - (e.clientX - this.panX) * kk;
      this.panY = e.clientY - (e.clientY - this.panY) * kk;
      this.zoom = nz;
      this.clampPan();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
    };
  }
}
