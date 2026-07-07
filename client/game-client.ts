import {
  PlayerPub,
  AttackPub,
  BoatPub,
  BuildingPub,
  BuildingType,
  HQ_RADIUS,
  HQ_EXPLODE_RADIUS,
} from '../shared/protocol';
import { playerColorRGB, playerColorCSS } from '../shared/color';
import { rleDecode } from '../shared/rle';

const FORT_BORDER: [number, number, number] = [222, 214, 196]; // каменная граница

const WATER: [number, number, number] = [58, 96, 140];
const WAR: [number, number, number] = [225, 36, 26]; // линия фронта
// метки стран/людей показываем, когда приблизились вдвое от обзорного зума;
// «корм» — только если он огромный или приближение очень сильное
const LABEL_ZOOM_MUL = 2;
const FOOD_LABEL_MUL = 5;
const FOOD_LABEL_CELLS = 4000;
// цвета нейтральной местности по типу почвы — как на классических картах мира
const TERRAIN: Record<number, [number, number, number]> = {
  1: [168, 190, 138], // трава
  2: [216, 203, 160], // песок
  3: [188, 183, 173], // камень
  4: [242, 244, 242], // снег
};

function fmtTroops(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

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

  // режим постройки: тип здания или null; клетка под курсором для предпросмотра
  buildMode: BuildingType | null = null;
  private hoverCell = -1;
  private buildings: BuildingPub[] = [];
  private fortField = new Int16Array(0); // владелец штаба на клетку (укрепления)
  private buildingsSig = '';
  private flashes: { cell: number; t0: number; big: boolean }[] = []; // вспышки взрыва
  private boatCum = new Map<
    number,
    { len: number; cum: number[]; total: number; wob: Float64Array }
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

  private attacks: AttackPub[] = [];
  private boats: BoatPub[] = [];
  private warSet = new Set<number>(); // с кем воюем: атакуем мы или атакуют нас
  private warLabels: { x: number; y: number; lines: string[] }[] = [];
  // сглаженные цвета нейтральной земли (переходы биомов), статичны за раунд
  private neutralRGB = new Uint8ClampedArray(0);
  private labelTick = 0;
  private warTick = 0;

  private zoom = 3;
  private panX = 0;
  private panY = 0;

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
      if (this.miniCanvas) {
        this.miniCanvas.width = w;
        this.miniCanvas.height = h;
        this.miniCanvas.style.aspectRatio = `${w} / ${h}`;
      }
    }
    rleDecode(terrainRle, this.terrain);
    rleDecode(ownersRle, this.owners);
    if (selfId > 0) this.selfId = selfId;
    this.warSet.clear();
    this.warLabels = [];
    this.buildings = [];
    this.buildingsSig = '';
    this.fortField = new Int16Array(this.cells);
    this.buildNeutralColors();
    this.repaintAll();
    this.fitView();
  }

  // Усредняем цвета биомов по окрестности 3x3 — плавные переходы между
  // травой, песком, камнем и снегом
  private buildNeutralColors() {
    this.neutralRGB = new Uint8ClampedArray(this.cells * 3);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = y * this.w + x;
        if (!this.terrain[c]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
            const t = this.terrain[ny * this.w + nx];
            if (!t) continue;
            const col = TERRAIN[t] ?? TERRAIN[1];
            r += col[0];
            g += col[1];
            b += col[2];
            n++;
          }
        }
        this.neutralRGB[c * 3] = r / n;
        this.neutralRGB[c * 3 + 1] = g / n;
        this.neutralRGB[c * 3 + 2] = b / n;
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

  // Предрасчёт маршрута лодки: накопленная длина + волнистые мировые координаты
  // каждой точки (покачивание зависит только от дистанции → статично)
  private buildBoatPath(path: number[], pts: number) {
    const WOB_AMP = 10;
    const WOB_FREQ = 0.08;
    const cum = new Array(pts);
    cum[0] = 0;
    for (let i = 1; i < pts; i++) {
      cum[i] =
        cum[i - 1] +
        Math.hypot(path[i * 2] - path[(i - 1) * 2], path[i * 2 + 1] - path[(i - 1) * 2 + 1]);
    }
    const total = cum[pts - 1] || 1;
    const wob = new Float64Array(pts * 2);
    for (let i = 0; i < pts; i++) {
      const ia = Math.max(0, i - 1);
      const ib = Math.min(pts - 1, i + 1);
      const dxn = path[ib * 2] - path[ia * 2];
      const dyn = path[ib * 2 + 1] - path[ia * 2 + 1];
      const len = Math.hypot(dxn, dyn) || 1;
      const taper = Math.sin(Math.PI * (cum[i] / total));
      const w = Math.sin(cum[i] * WOB_FREQ) * WOB_AMP * taper;
      wob[i * 2] = path[i * 2] - (dyn / len) * w;
      wob[i * 2 + 1] = path[i * 2 + 1] + (dxn / len) * w;
    }
    return { len: path.length, cum, total, wob };
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
      if (b.progress < 1) continue; // ещё строится — не укрепляет
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
      } else if (this.isBorder(c, o)) {
        [r, g, b] = playerColorRGB(o);
        r = (r * 0.55) | 0;
        g = (g * 0.55) | 0;
        b = (b * 0.55) | 0;
      } else {
        [r, g, b] = playerColorRGB(o);
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

  // Не даём укатить карту за край экрана
  private clampPan() {
    if (!this.w) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const mw = this.w * this.zoom;
    const mh = this.h * this.zoom;
    this.panX = mw <= w ? (w - mw) / 2 : Math.min(0, Math.max(w - mw, this.panX));
    this.panY = mh <= h ? (h - mh) / 2 : Math.min(0, Math.max(h - mh, this.panY));
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
    // морские десанты: волнистый маршрут статичен (зависит только от дистанции)
    // — считаем один раз и кэшируем; позицию интерполируем между апдейтами
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
      ctx.beginPath();
      ctx.arc(bx, by, rad, 0, Math.PI * 2);
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
      ctx.strokeText(label, bx, by - rad - fs * 0.7);
      ctx.fillText(label, bx, by - rad - fs * 0.7);
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

  // Здания на карте + предпросмотр в режиме постройки (зелёный/серый)
  private drawBuildings(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const r = Math.max(5, Math.min(16, this.zoom * 2.2));
    const now = performance.now();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const b of this.buildings) {
      const sx = this.panX + (b.cell % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((b.cell / this.w | 0) + 0.5) * this.zoom;
      if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue; // вне экрана
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
      ctx.font = `${r * 1.2}px sans-serif`;
      ctx.fillText(b.level >= 2 ? '🛡️' : '🛡', sx, sy + 1);
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
    // вспышки взрыва (расширяющийся круг, ~0.6с)
    this.flashes = this.flashes.filter((f) => now - f.t0 < 600);
    for (const f of this.flashes) {
      const p = (now - f.t0) / 600;
      const sx = this.panX + (f.cell % this.w + 0.5) * this.zoom;
      const sy = this.panY + ((f.cell / this.w | 0) + 0.5) * this.zoom;
      const maxR = (f.big ? HQ_EXPLODE_RADIUS : r / this.zoom + 2) * this.zoom;
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.beginPath();
      ctx.arc(sx, sy, maxR * (0.3 + p * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = f.big ? 'rgba(255,120,40,0.5)' : 'rgba(255,180,60,0.5)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ff8a2a';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // предпросмотр под курсором
    if (this.buildMode && this.hoverCell >= 0) {
      const ok = this.canBuildAt(this.hoverCell);
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
  }

  private drawMinimap() {
    if (!this.miniCtx || !this.w) return;
    this.miniCtx.drawImage(this.off, 0, 0);
    // рамка видимой области
    this.miniCtx.strokeStyle = 'rgba(15,20,30,0.9)';
    this.miniCtx.lineWidth = Math.max(1.5, this.w / 300);
    this.miniCtx.strokeRect(
      -this.panX / this.zoom,
      -this.panY / this.zoom,
      window.innerWidth / this.zoom,
      window.innerHeight / this.zoom
    );
  }

  attachMinimap(canvas: HTMLCanvasElement): () => void {
    this.miniCanvas = canvas;
    this.miniCtx = canvas.getContext('2d');
    if (this.w) {
      canvas.width = this.w;
      canvas.height = this.h;
      canvas.style.aspectRatio = `${this.w} / ${this.h}`;
    }
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
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (this.w && this.img) {
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
        this.drawBuildings(ctx, dpr);
        this.drawMinimap();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return; // правый клик — контекстное меню, не пан/атака
      this.anim = null; // пользователь взял управление — стоп автозум
      down = { x: e.clientX, y: e.clientY };
      panning = false;
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
      if (this.buildMode) this.hoverCell = cellUnder(e); // предпросмотр здания
      if (!down) return;
      if (panning || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
        panning = true;
        this.panX += e.movementX;
        this.panY += e.movementY;
        this.clampPan();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (down && !panning && this.w) {
        const cell = cellUnder(e);
        if (cell >= 0) {
          if (this.buildMode) this.onBuild?.(cell); // ставим здание
          else this.onCellClick?.(cell, e.clientX, e.clientY);
        }
      }
      down = null;
      panning = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.anim = null; // ручной зум отменяет автозум
      const k = Math.exp(-e.deltaY * 0.0012);
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
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
    };
  }
}
