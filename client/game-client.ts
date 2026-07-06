import { PlayerPub, AttackPub } from '../shared/protocol';
import { playerColorRGB } from '../shared/color';
import { rleDecode } from '../shared/rle';

const WATER: [number, number, number] = [58, 96, 140];
const WAR: [number, number, number] = [225, 36, 26]; // линия фронта
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

  onCellClick: ((cell: number) => void) | null = null;

  private img: ImageData | null = null;
  private off = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;
  private dirty = true;

  private players: PlayerPub[] = [];
  private labels = new Map<number, { x: number; y: number }>();
  private miniCanvas: HTMLCanvasElement | null = null;
  private miniCtx: CanvasRenderingContext2D | null = null;

  private attacks: AttackPub[] = [];
  private warSet = new Set<number>(); // с кем воюем: атакуем мы или атакуют нас
  private warLabels: { x: number; y: number; lines: string[] }[] = [];
  // сглаженные цвета нейтральной земли (переходы биомов), статичны за раунд
  private neutralRGB = new Uint8ClampedArray(0);
  private labelTick = 0;
  private warTick = 0;

  private zoom = 3;
  private panX = 0;
  private panY = 0;

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

  // Центроиды территорий — точки, где рисуем имена игроков.
  // На больших картах пересчитываем раз в полсекунды
  setPlayers(players: PlayerPub[]) {
    this.players = players;
    if (this.labelTick++ % 5 !== 0) return;
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
    if (changed || this.warTick++ % 3 === 0) this.computeWarLabels();
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
      } else if (o === this.selfId && this.warSet.size && this.neighborInWar(c)) {
        [r, g, b] = WAR; // наша сторона фронта
      } else if (this.warSet.has(o) && this.neighborIs(c, this.selfId)) {
        [r, g, b] = WAR; // сторона противника
      } else {
        [r, g, b] = playerColorRGB(o);
        if (this.isBorder(c, o)) {
          r = (r * 0.55) | 0;
          g = (g * 0.55) | 0;
          b = (b * 0.55) | 0;
        }
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

  // Стартовый вид: карта целиком по размеру экрана
  private fitView() {
    if (!this.w) return;
    const z = Math.min(window.innerWidth / this.w, window.innerHeight / this.h) * 0.97;
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
    for (const p of this.players) {
      if (!p.alive || p.cells === 0) continue;
      const l = this.labels.get(p.id);
      if (!l) continue;
      let size = Math.sqrt(p.cells) * this.zoom * 0.22;
      if (p.id === this.selfId) size = Math.max(size, 10);
      if (size < 8) continue; // слишком мелко — не захламляем карту
      size = Math.min(size, 26);
      const sx = this.panX + l.x * this.zoom;
      const sy = this.panY + l.y * this.zoom;
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
    // выделенные войска у линии фронта
    for (const wl of this.warLabels) {
      const size = Math.min(16, Math.max(11, this.zoom * 3));
      const sx = this.panX + wl.x * this.zoom;
      let sy = this.panY + wl.y * this.zoom;
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

    const loop = () => {
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
        this.drawMinimap();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      panning = false;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
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
        const cx = Math.floor((e.clientX - this.panX) / this.zoom);
        const cy = Math.floor((e.clientY - this.panY) / this.zoom);
        if (cx >= 0 && cy >= 0 && cx < this.w && cy < this.h) {
          this.onCellClick?.(cy * this.w + cx);
        }
      }
      down = null;
      panning = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
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

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }
}
