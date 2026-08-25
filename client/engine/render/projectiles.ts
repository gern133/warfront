import { NUKES, DRONE_BLAST_R } from '../../../shared/protocol';
import { DRONE_DOT_SIZE_MAX, SHIP_DOT_RADIUS_MAX } from '../constants';
import { playerColorCSS } from '../../../shared/color';
import { warshipRank } from '../../../shared/constants/warship';
import type { GameClient } from '../GameClient';

// Золото знаков различия боевых кораблей (обводка круга + полоски звания)
const RANK_GOLD = '#ffcc33';

// ─── Рой дронов «Мопед» ──────────────────────────────────────────────────────
// Рисуется спрайтами из кэша, а не построением путей. Раньше на КАЖДЫЙ дрон каждый
// кадр приходилось: save/restore, translate+rotate, сборка строки цвета и ТРИ пути
// (фюзеляж, крылья, хвост) с fill+stroke — то есть шесть вызовов рисования. При рое
// в 392 дрона это 2352 вызова на кадр (замер), а кадров 60 в секунду.
//
// Теперь самолётик отрисовывается один раз в offscreen-канвас для каждого сочетания
// «цвет владельца × размер × поворот», и в кадре остаётся один drawImage на дрон:
// без матричных операций, без смены состояния контекста и без аллокаций.
const SPRITE_ANGLES = 24; // шагов поворота в кэше (15° — на глаз незаметно)
const spriteCache = new Map<string, HTMLCanvasElement[]>();

function droneSprites(owner: number, size: number, dpr: number): HTMLCanvasElement[] {
  const key = `${owner}|${size}|${dpr}`;
  let frames = spriteCache.get(key);
  if (frames) return frames;
  frames = [];
  const s = size;
  const box = Math.ceil(s * 2.2) + 2; // самолётик вписан с запасом на поворот
  const half = box / 2;
  for (let i = 0; i < SPRITE_ANGLES; i++) {
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(box * dpr);
    cv.height = Math.ceil(box * dpr);
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.translate(half, half);
    c.rotate((i / SPRITE_ANGLES) * Math.PI * 2);
    c.fillStyle = playerColorCSS(owner);
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 1;
    c.beginPath(); // фюзеляж (нос вперёд)
    c.moveTo(s, 0);
    c.lineTo(-s * 0.4, s * 0.28);
    c.lineTo(-s * 0.4, -s * 0.28);
    c.closePath();
    c.fill();
    c.stroke();
    c.beginPath(); // крылья
    c.moveTo(-s * 0.05, s * 0.85);
    c.lineTo(-s * 0.05, -s * 0.85);
    c.lineTo(-s * 0.3, -s * 0.7);
    c.lineTo(-s * 0.3, s * 0.7);
    c.closePath();
    c.fill();
    c.stroke();
    c.beginPath(); // хвост
    c.moveTo(-s * 0.55, s * 0.35);
    c.lineTo(-s * 0.55, -s * 0.35);
    c.lineTo(-s * 0.8, -s * 0.3);
    c.lineTo(-s * 0.8, s * 0.3);
    c.closePath();
    c.fill();
    c.stroke();
    frames.push(cv);
  }
  spriteCache.set(key, frames);
  return frames;
}

const TAU = Math.PI * 2;

export function drawDrones(gc: GameClient, ctx: CanvasRenderingContext2D, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const z = gc.zoom, px = gc.panX, py = gc.panY;
  const now = performance.now();
  // вспышки взрывов (живут ~450мс, расходятся кольцом)
  gc.droneFlashes = gc.droneFlashes.filter((f) => now - f.t0 < 450);
  for (const f of gc.droneFlashes) {
    const p = (now - f.t0) / 450;
    const cx = px + f.x * z, cy = py + f.y * z;
    ctx.beginPath();
    ctx.arc(cx, cy, DRONE_BLAST_R * z * (0.3 + p * 0.7), 0, TAU);
    ctx.strokeStyle = `rgba(255,${(120 + p * 100) | 0},40,${(1 - p) * 0.85})`;
    ctx.lineWidth = Math.max(1.5, z * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, DRONE_BLAST_R * z * 0.25 * (1 - p), 0, TAU);
    ctx.fillStyle = `rgba(255,200,90,${(1 - p) * 0.7})`;
    ctx.fill();
  }
  const n = gc.droneCount;
  if (!n) return;
  const dx = gc.droneX, dy = gc.droneY, da = gc.droneA, dow = gc.droneOwner;
  const vw = window.innerWidth, vh = window.innerHeight;
  const size = Math.round(Math.max(4, Math.min(11, z * 1.6))); // размер модельки
  if (size <= DRONE_DOT_SIZE_MAX) {
    // ОТДАЛЁННАЯ КАРТА: на 4–5 пикселях детали самолётика всё равно не видно, а
    // платить за них приходится полностью. Рисуем точками и группируем по
    // владельцу, чтобы fillStyle ставился один раз на группу, а не на дрон.
    const d = Math.max(2, size - 1);
    const owners: number[] = [];
    for (let i = 0; i < n; i++) if (!owners.includes(dow[i])) owners.push(dow[i]);
    for (const owner of owners) {
      ctx.fillStyle = playerColorCSS(owner);
      for (let i = 0; i < n; i++) {
        if (dow[i] !== owner) continue;
        const cx = px + dx[i] * z, cy = py + dy[i] * z;
        if (cx < -20 || cy < -20 || cx > vw + 20 || cy > vh + 20) continue;
        ctx.fillRect(cx - d / 2, cy - d / 2, d, d);
      }
    }
    return;
  }
  // БЛИЗКО: спрайт из кэша — один drawImage на дрон, без смены состояния
  const box = Math.ceil(size * 2.2) + 2;
  const half = box / 2;
  for (let i = 0; i < n; i++) {
    const cx = px + dx[i] * z, cy = py + dy[i] * z;
    if (cx < -20 || cy < -20 || cx > vw + 20 || cy > vh + 20) continue;
    const frames = droneSprites(dow[i], size, dpr);
    // курс → индекс кадра поворота
    let k = Math.round((da[i] / TAU) * SPRITE_ANGLES) % SPRITE_ANGLES;
    if (k < 0) k += SPRITE_ANGLES;
    ctx.drawImage(frames[k], cx - half, cy - half, box, box);
  }
}

// ─── Трейд-суда ─────────────────────────────────────────────────────────────
// Судов бывают СОТНИ (в замере 400 при 43 портах). Раньше на каждое каждый кадр
// делалось: beginPath + arc + fill + stroke и две установки стиля, причём fillStyle
// собирался строкой — то есть ~1800 вызовов и 400 аллокаций на кадр при 60 кадрах/с.
//
// Теперь так же, как у дронов: кружок с обводкой отрисован заранее в offscreen-канвас
// (для каждого владельца и радиуса), и в кадре остаётся ОДИН drawImage на судно.
// На сильном отдалении — точки, сгруппированные по владельцу.
const shipSpriteCache = new Map<string, HTMLCanvasElement>();

function shipSprite(owner: number, rad: number, dpr: number): HTMLCanvasElement {
  const key = `${owner}|${rad}|${dpr}`;
  let cv = shipSpriteCache.get(key);
  if (cv) return cv;
  const box = Math.ceil(rad * 2 + 4);
  cv = document.createElement('canvas');
  cv.width = Math.ceil(box * dpr);
  cv.height = Math.ceil(box * dpr);
  const c = cv.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.beginPath();
  c.arc(box / 2, box / 2, rad, 0, Math.PI * 2);
  c.fillStyle = playerColorCSS(owner);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.7)';
  c.lineWidth = 1.5;
  c.stroke();
  shipSpriteCache.set(key, cv);
  return cv;
}

export function drawShips(gc: GameClient, ctx: CanvasRenderingContext2D, dpr: number) {
  const n = gc.shipCount;
  if (!n) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = window.innerWidth, vh = window.innerHeight;
  const z = gc.zoom, px = gc.panX, py = gc.panY;
  const sx0 = gc.shipX, sy0 = gc.shipY, sow = gc.shipOwner;
  const rad = Math.round(Math.max(2.5, Math.min(6, z * 0.9)) * 2) / 2; // шаг 0.5 — меньше вариантов в кэше
  if (rad <= SHIP_DOT_RADIUS_MAX) {
    // ОТДАЛЁННАЯ КАРТА: обводка на 2–3 пикселях не видна, рисуем точки. Кружками, а не
    // квадратами — так они не выбиваются из остальной картинки.
    //
    // Способ выбран замером (409 судов, 18 владельцев — столько их в партии на 293
    // страны), мс на кадр, программный рендер / с GPU:
    //   квадраты fillRect            0.123 / 0.072
    //   кружки одним путём на владельца  0.371 / 0.071  ← это
    //   кружки arc+fill на каждое    0.538 / 0.370
    //   кружки спрайтом drawImage    0.722 / 0.751
    // То есть все кружки одного владельца собираются в ОДИН путь и заливаются одним
    // fill: на GPU это ровно цена квадратов. Спрайты (как у дронов, где их выручают
    // повороты и размер) здесь наоборот худший вариант — на точках в 2–5 пикселей
    // накладные расходы drawImage перевешивают всё.
    const r = Math.max(1, Math.round(rad * 2) / 2);
    const owners: number[] = [];
    for (let i = 0; i < n; i++) if (!owners.includes(sow[i])) owners.push(sow[i]);
    for (const owner of owners) {
      ctx.fillStyle = playerColorCSS(owner);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (sow[i] !== owner) continue;
        const x = px + sx0[i] * z, y = py + sy0[i] * z;
        if (x < -20 || y < -20 || x > vw + 20 || y > vh + 20) continue;
        // moveTo в точку начала дуги (угол 0) — иначе подпути соединились бы линией
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
    }
    return;
  }
  const box = Math.ceil(rad * 2 + 4);
  const half = box / 2;
  for (let i = 0; i < n; i++) {
    const x = px + sx0[i] * z, y = py + sy0[i] * z;
    if (x < -20 || y < -20 || x > vw + 20 || y > vh + 20) continue;
    ctx.drawImage(shipSprite(sow[i], rad, dpr), x - half, y - half, box, box);
  }
}

// Боевые корабли: крупные (≈×5 трейдера) кружки с «башней», полоской здоровья,
// кольцом выделения; пули-пиксели и рамка выделения
export function drawFleet(gc: GameClient, ctx: CanvasRenderingContext2D, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = gc.panX, py = gc.panY, z = gc.zoom;
  const vw = window.innerWidth, vh = window.innerHeight;
  // пули — маленькие яркие пиксели, летят к цели
  const bl = gc.bullets;
  if (bl.length) {
    const br = Math.max(1.5, Math.min(4, z * 0.6));
    ctx.fillStyle = '#ffe14d';
    for (let i = 0; i + 1 < bl.length; i += 2) {
      const bx = px + bl[i] * z, by = py + bl[i + 1] * z;
      if (bx < -10 || by < -10 || bx > vw + 10 || by > vh + 10) continue;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const rad = Math.max(11, Math.min(30, z * 4.5)); // ≈×5 от трейд-кораблей
  for (const wship of gc.warships) {
    const sx = px + wship.x * z, sy = py + wship.y * z;
    if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue;
    if (wship.owner === gc.selfId && gc.selectedWarships.has(wship.id)) {
      ctx.beginPath();
      ctx.arc(sx, sy, rad + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    const rank = warshipRank(wship.xp ?? 0);
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fillStyle = playerColorCSS(wship.owner);
    ctx.fill();
    // Заслуженный корабль обведён золотом, а не чёрным: ранг виден даже на
    // сильном отдалении, когда полоски ниже становятся мельче пикселя.
    ctx.lineWidth = Math.max(2, rad * 0.18);
    ctx.strokeStyle = rank > 0 ? RANK_GOLD : 'rgba(0,0,0,0.65)';
    ctx.stroke();
    // иконка корабля (белый силуэт поверх цветного круга владельца)
    gc.drawIcon(ctx, 'warship', sx, sy, rad * 1.3);
    // Звание — золотые полоски под кораблём, по одной за пройденную кратность
    // здоровья (×1.5/3/6/10). Рисуем только когда полоска шире пикселя, иначе на
    // отдалении это тысячи fillRect ни за чем.
    if (rank > 0) {
      const sh = rad * 0.15;
      if (sh >= 1.2) {
        const sw = rad * 1.15;
        const gap = sh * 0.75;
        let by2 = sy + rad + sh * 1.4;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(sx - sw / 2 - 1, by2 - 1, sw + 2, rank * (sh + gap) - gap + 2);
        ctx.fillStyle = RANK_GOLD;
        for (let i = 0; i < rank; i++) {
          ctx.fillRect(sx - sw / 2, by2, sw, sh);
          by2 += sh + gap;
        }
      }
    }
    // полоска здоровья над кораблём (если ранен)
    if (wship.hp < 1) {
      const bw = rad * 2, bh = Math.max(3, rad * 0.2);
      const bx = sx - rad, by = sy - rad - bh - 3;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = wship.hp > 0.5 ? '#4caf50' : wship.hp > 0.25 ? '#ffb300' : '#e53935';
      ctx.fillRect(bx, by, bw * wship.hp, bh);
    }
  }
  // рамка выделения (RTS)
  if (gc.selBox) {
    const b = gc.selBox;
    const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
    const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    ctx.fillStyle = 'rgba(255,225,77,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,225,77,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
  }
}

// Ракеты: баллистическая дуга, трассер за головой, светящийся кружок, кольцо
// радиуса поражения в цели
export function drawMissiles(gc: GameClient, ctx: CanvasRenderingContext2D, dpr: number) {
  if (!gc.missiles.length) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = gc.panX;
  const py = gc.panY;
  const z = gc.zoom;
  for (const m of gc.missiles) {
    const dist = Math.hypot(m.tx - m.sx, m.ty - m.sy);
    // перехватчик летит прямой (цель уже в точке встречи на дуге ракеты);
    // ядерка — по баллистической дуге
    const arc = m.intercept ? 0 : Math.min(dist * 0.4, 140);
    const pos = (t: number): [number, number] => {
      const gx = m.sx + (m.tx - m.sx) * t;
      const gy = m.sy + (m.ty - m.sy) * t;
      const lift = arc * Math.sin(Math.PI * t);
      return [px + gx * z, py + gy * z - lift * z];
    };
    // кольцо радиуса поражения в цели
    const spec = NUKES[m.kind];
    if (spec) {
      const [tx, ty] = pos(1);
      ctx.beginPath();
      ctx.arc(tx, ty, spec.radius * z, 0, Math.PI * 2);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,80,40,0.5)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // цвет/размер: ядерка — жёлто-оранжевая; перехватчик — бирюзовый;
    // водородная — крупнее (×1.5), ярче, с сильным малиново-оранжевым свечением
    const hydro = m.kind === 'hydro';
    const trail = m.intercept
      ? 'rgba(90,230,255,0.6)'
      : hydro
        ? 'rgba(255,140,60,0.8)'
        : 'rgba(255,215,120,0.55)';
    const glow = m.intercept ? '#4de1ff' : hydro ? '#ff5a2a' : '#ffcf4d';
    const head = m.intercept ? '#d6fbff' : hydro ? '#ffffff' : '#fff2b0';
    // трассер 0..prog (у водородной — толще)
    const steps = 26;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const [x, y] = pos((i / steps) * m.prog);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = hydro ? 3.5 : 2;
    ctx.strokeStyle = trail;
    ctx.stroke();
    // светящаяся голова (у водородной — крупнее и с ореолом-свечением)
    const [hx, hy] = pos(Math.min(1, m.prog));
    const rad = Math.max(3, Math.min(8, z * 1.3)) * (hydro ? 1.5 : 1);
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = hydro ? 34 : 18;
    if (hydro) {
      // мягкий ореол вокруг головы — видно, что летит гидро-бомба
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, rad * 3);
      halo.addColorStop(0, 'rgba(255,120,50,0.55)');
      halo.addColorStop(1, 'rgba(255,120,50,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(hx, hy, rad * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(hx, hy, rad, 0, Math.PI * 2);
    ctx.fillStyle = head;
    ctx.fill();
    ctx.restore();
  }
}
