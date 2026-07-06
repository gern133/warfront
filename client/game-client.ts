import { MAP_W, MAP_H, CELLS, PlayerPub, AttackPub } from '../shared/protocol';
import { playerColorRGB } from '../shared/color';

const WATER: [number, number, number] = [15, 34, 60];
const NEUTRAL: [number, number, number] = [122, 132, 106];
const WAR: [number, number, number] = [232, 46, 36]; // линия фронта

function fmtTroops(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

export class GameClient {
  terrain = new Uint8Array(CELLS);
  owners = new Int16Array(CELLS);
  selfId = -1;

  onCellClick: ((cell: number) => void) | null = null;

  private img = new ImageData(MAP_W, MAP_H);
  private off = document.createElement('canvas');
  private offCtx: CanvasRenderingContext2D;
  private dirty = true;

  private players: PlayerPub[] = [];
  private labels = new Map<number, { x: number; y: number }>();
  private miniCtx: CanvasRenderingContext2D | null = null;

  private attacks: AttackPub[] = [];
  private warSet = new Set<number>(); // с кем воюем: атакуем мы или атакуют нас
  private warLabels: { x: number; y: number; lines: string[] }[] = [];

  private zoom = 3;
  private panX = 0;
  private panY = 0;

  constructor() {
    this.off.width = MAP_W;
    this.off.height = MAP_H;
    this.offCtx = this.off.getContext('2d')!;
  }

  applyInit(selfId: number, terrain: number[], owners: number[]) {
    this.terrain.set(terrain);
    this.owners.set(owners);
    if (selfId > 0) this.selfId = selfId;
    this.repaintAll();
    this.fitView();
  }

  applyUpdate(changes: number[]) {
    if (!changes.length) return;
    for (let i = 0; i < changes.length; i += 2) {
      this.owners[changes[i]] = changes[i + 1];
    }
    // перекрашиваем изменённые клетки и соседей (у них могла поменяться граница)
    for (let i = 0; i < changes.length; i += 2) {
      const c = changes[i];
      this.paint(c);
      const x = c % MAP_W;
      if (x > 0) this.paint(c - 1);
      if (x < MAP_W - 1) this.paint(c + 1);
      if (c >= MAP_W) this.paint(c - MAP_W);
      if (c < CELLS - MAP_W) this.paint(c + MAP_W);
    }
    this.dirty = true;
  }

  // Центроиды территорий — точки, где рисуем имена игроков
  setPlayers(players: PlayerPub[]) {
    this.players = players;
    const acc = new Map<number, { sx: number; sy: number; n: number }>();
    for (let c = 0; c < CELLS; c++) {
      const o = this.owners[c];
      if (o <= 0) continue;
      let a = acc.get(o);
      if (!a) {
        a = { sx: 0, sy: 0, n: 0 };
        acc.set(o, a);
      }
      a.sx += c % MAP_W;
      a.sy += (c / MAP_W) | 0;
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
    this.computeWarLabels();
  }

  // Точки у линии фронта, где рисуем выделенные войска
  private computeWarLabels() {
    this.warLabels = [];
    if (!this.warSet.size) return;
    const acc = new Map<number, { sx: number; sy: number; n: number }>();
    for (let c = 0; c < CELLS; c++) {
      const o = this.owners[c];
      if (!this.warSet.has(o) || !this.neighborIs(c, this.selfId)) continue;
      let a = acc.get(o);
      if (!a) {
        a = { sx: 0, sy: 0, n: 0 };
        acc.set(o, a);
      }
      a.sx += c % MAP_W;
      a.sy += (c / MAP_W) | 0;
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
    const x = c % MAP_W;
    return (
      (x > 0 && this.owners[c - 1] === id) ||
      (x < MAP_W - 1 && this.owners[c + 1] === id) ||
      (c >= MAP_W && this.owners[c - MAP_W] === id) ||
      (c < CELLS - MAP_W && this.owners[c + MAP_W] === id)
    );
  }

  private neighborInWar(c: number): boolean {
    const x = c % MAP_W;
    return (
      (x > 0 && this.warSet.has(this.owners[c - 1])) ||
      (x < MAP_W - 1 && this.warSet.has(this.owners[c + 1])) ||
      (c >= MAP_W && this.warSet.has(this.owners[c - MAP_W])) ||
      (c < CELLS - MAP_W && this.warSet.has(this.owners[c + MAP_W]))
    );
  }

  private repaintAll() {
    for (let c = 0; c < CELLS; c++) this.paint(c);
    this.dirty = true;
  }

  private paint(c: number) {
    const d = this.img.data;
    const i = c * 4;
    let r: number, g: number, b: number;
    if (!this.terrain[c]) {
      [r, g, b] = WATER;
    } else {
      const o = this.owners[c];
      if (o === 0) {
        [r, g, b] = NEUTRAL;
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
    const x = c % MAP_W;
    return (
      (x > 0 && this.owners[c - 1] !== o) ||
      (x < MAP_W - 1 && this.owners[c + 1] !== o) ||
      (c >= MAP_W && this.owners[c - MAP_W] !== o) ||
      (c < CELLS - MAP_W && this.owners[c + MAP_W] !== o)
    );
  }

  // Минимальный зум, при котором карта закрывает весь экран (cover)
  private minZoom() {
    return Math.max(window.innerWidth / MAP_W, window.innerHeight / MAP_H);
  }

  private fitView() {
    const z = this.minZoom();
    this.zoom = z;
    this.panX = (window.innerWidth - MAP_W * z) / 2;
    this.panY = (window.innerHeight - MAP_H * z) / 2;
  }

  // Не даём укатить карту за край экрана
  private clampPan() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const mw = MAP_W * this.zoom;
    const mh = MAP_H * this.zoom;
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
      ctx.font = `700 ${size}px -apple-system, 'Segoe UI', sans-serif`;
      ctx.strokeText(p.name, sx, sy);
      ctx.fillText(p.name, sx, sy);
      if (size > 11) {
        const troops = fmtTroops(p.troops);
        const ty = sy + size * 0.95;
        ctx.font = `600 ${size * 0.72}px -apple-system, 'Segoe UI', sans-serif`;
        ctx.strokeText(troops, sx, ty);
        ctx.fillText(troops, sx, ty);
      }
    }
    // выделенные войска у линии фронта
    for (const wl of this.warLabels) {
      const size = Math.min(16, Math.max(11, this.zoom * 3));
      const sx = this.panX + wl.x * this.zoom;
      let sy = this.panY + wl.y * this.zoom;
      ctx.font = `800 ${size}px -apple-system, 'Segoe UI', sans-serif`;
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
    if (!this.miniCtx) return;
    this.miniCtx.drawImage(this.off, 0, 0);
    // рамка видимой области
    this.miniCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    this.miniCtx.lineWidth = 1.5;
    this.miniCtx.strokeRect(
      -this.panX / this.zoom,
      -this.panY / this.zoom,
      window.innerWidth / this.zoom,
      window.innerHeight / this.zoom
    );
  }

  attachMinimap(canvas: HTMLCanvasElement): () => void {
    canvas.width = MAP_W;
    canvas.height = MAP_H;
    this.miniCtx = canvas.getContext('2d');
    const toCenter = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * MAP_W;
      const my = ((e.clientY - r.top) / r.height) * MAP_H;
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
      if (this.dirty) {
        this.offCtx.putImageData(this.img, 0, 0);
        this.dirty = false;
      }
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(this.panX, this.panY);
      ctx.scale(this.zoom, this.zoom);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.off, 0, 0);
      this.drawNames(ctx, dpr);
      this.drawMinimap();
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
      if (down && !panning) {
        const cx = Math.floor((e.clientX - this.panX) / this.zoom);
        const cy = Math.floor((e.clientY - this.panY) / this.zoom);
        if (cx >= 0 && cy >= 0 && cx < MAP_W && cy < MAP_H) {
          this.onCellClick?.(cy * MAP_W + cx);
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
