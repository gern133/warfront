// Карта Земли из реальных географических данных Natural Earth (50m):
// сканлайн-растеризация настоящих береговых линий + вычитание крупных озёр
// + классификация местности: 1 трава, 2 песок, 3 камень, 4 снег.

import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);

export const EARTH_W = 1920;
export const EARTH_H = 900;
// карта обрезана по широте как классические карты мира: Гренландия у верхнего
// края, Антарктида полосой у нижнего, без пустых полярных океанов
const LAT_TOP = 84;
const LAT_BOT = -85;
const LAT_SPAN = LAT_TOP - LAT_BOT;

function rowLat(y: number, h: number): number {
  return LAT_TOP - ((y + 0.5) / h) * LAT_SPAN;
}

function latRow(lat: number, h: number): number {
  return Math.floor(((LAT_TOP - lat) / LAT_SPAN) * h);
}

export const T_WATER = 0;
export const T_GRASS = 1;
export const T_SAND = 2;
export const T_ROCK = 3;
export const T_SNOW = 4;

type Ring = [number, number][]; // [lon, lat]

// Крупные озёра — в данных Natural Earth "land" они считаются сушей. Контуры
// приближённые (на этом масштабе ~14 км/клетка), но узнаваемые по форме.
const LAKES: Ring[] = [
  // Великие озёра ---------------------------------------------------------
  // Верхнее — вытянутая горизонтальная линза сверху
  [[-92, 47.0], [-90, 46.7], [-87, 46.6], [-85, 46.7], [-84.4, 47.0], [-84.9, 47.6], [-87, 48.0], [-89, 48.2], [-90.8, 47.9], [-91.9, 47.5]],
  // Мичиган — вертикальное, свисает на юг
  [[-87.6, 45.8], [-86.1, 45.9], [-85.5, 45.0], [-85.8, 43.5], [-86.5, 42.2], [-87.2, 41.7], [-87.9, 42.6], [-88.0, 44.0], [-87.9, 45.2]],
  // Гурон — с Джорджиан-Бей на северо-востоке
  [[-84.7, 45.9], [-83.4, 45.9], [-82.1, 45.2], [-80.4, 45.3], [-80.0, 44.6], [-81.2, 44.2], [-82.0, 43.4], [-83.2, 43.4], [-84.2, 44.0], [-84.6, 45.0]],
  // Эри — горизонтальное, юго-восточнее
  [[-83.4, 41.7], [-81.5, 41.5], [-79.8, 42.2], [-78.9, 42.5], [-79.5, 42.9], [-81.5, 42.7], [-83.0, 42.4], [-83.5, 42.0]],
  // Онтарио — небольшое, восточнее Эри
  [[-79.7, 43.3], [-78, 43.2], [-76.4, 43.5], [-76.2, 44.0], [-77.5, 44.1], [-79.2, 43.9], [-79.8, 43.6]],
  // Каспийское море — узкое, сильно вытянутое с севера на юг ----------------
  [[47.5, 47.1], [49.5, 46.6], [51.8, 46.5], [51.3, 45.0], [51.0, 43.5], [52.8, 42.6], [53.6, 41.5], [53.9, 40.0], [53.0, 38.0], [51.5, 36.8], [49.7, 37.2], [49.0, 39.0], [49.6, 40.5], [48.6, 42.2], [47.6, 43.8], [46.9, 45.6]],
  // Аральское море — между Казахстаном (север) и Узбекистаном (юг) ----------
  [[58.4, 46.7], [59.8, 46.6], [61.2, 45.7], [61.3, 44.8], [60.2, 44.1], [59.2, 44.6], [58.6, 45.4], [58.2, 46.1]],
];

// Реальные каналы и узкие проливы. В растре 50m они уже 1–2 клеток и «зарастают»
// сушей, из-за чего торговые маршруты рвутся. Прорезаем их водой, чтобы корабли
// проходили насквозь (ширина игровая, крупнее реальной — иначе не судоходно).
// Каждый — ломаная из точек [lon, lat] и радиус прорезаемого канала (в клетках).
const CANALS: { pts: [number, number][]; r: number }[] = [
  // Суэцкий канал: Средиземное море → Красное море (тянем до широкой открытой воды)
  { pts: [[32.2, 32.0], [32.4, 30.6], [32.7, 29.8], [33.5, 28.2], [34.8, 26.5], [36.0, 24.5]], r: 1 },
  // Баб-эль-Мандебский пролив: Красное море → Аденский залив (Индийский океан)
  { pts: [[42.0, 14.5], [43.0, 12.8], [44.2, 12.0], [46.0, 11.6]], r: 1 },
  // Панамский канал: Карибское море → Тихий океан
  { pts: [[-80.5, 10.0], [-79.9, 9.2], [-79.5, 8.5], [-79.2, 7.8]], r: 1 },
  // Гибралтарский пролив: Атлантика → Средиземное море
  { pts: [[-7.5, 36.0], [-6.0, 35.95], [-5.0, 35.9], [-3.5, 36.0]], r: 1 },
  // Босфор → Мраморное море → Дарданеллы: Чёрное море → Эгейское/Средиземное
  { pts: [[29.3, 41.4], [29.0, 41.0], [28.0, 40.7], [26.7, 40.3], [25.6, 39.8]], r: 1 },
];

// Коридор канала в грубой водной сетке: судоходность узкого канала грубая сетка
// (блок K×K, проходим только если весь водный) сама не видит — поэтому вдоль
// каждого канала принудительно помечаем блоки водой. Возвращает индексы блоков.
export function canalCoarseCells(w: number, h: number, ck: number, cw: number, ch: number): number[] {
  const set = new Set<number>();
  const add = (cx: number, cy: number) => {
    if (cy < 0 || cy >= ch) return;
    set.add(cy * cw + (((cx % cw) + cw) % cw)); // заворот по долготе
  };
  for (const canal of CANALS) {
    const pts = canal.pts;
    let px = -999;
    let py = -999;
    for (let i = 0; i + 1 < pts.length; i++) {
      const x0 = ((pts[i][0] + 180) / 360) * w;
      const y0 = latRow(pts[i][1], h);
      const x1 = ((pts[i + 1][0] + 180) / 360) * w;
      const y1 = latRow(pts[i + 1][1], h);
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = Math.floor((x0 + (x1 - x0) * t) / ck);
        const cy = Math.floor((y0 + (y1 - y0) * t) / ck);
        // тонкий коридор в 1 блок; при диагональном переходе добавляем ортогональный
        // мостик, чтобы обход воды (без срезания углов) не разрывался
        if (px !== -999 && cx !== px && cy !== py) add(cx, py);
        add(cx, cy);
        px = cx;
        py = cy;
      }
    }
  }
  return [...set];
}

// прорезаем диск воды (mask=0) с заворотом по долготе
function carveDisk(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number) {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = (((cx + dx) % w) + w) % w;
      mask[y * w + x] = 0;
    }
  }
}

// прорезаем все каналы: идём по ломаной с мелким шагом и чистим диск
function carveCanals(mask: Uint8Array, w: number, h: number) {
  for (const canal of CANALS) {
    const pts = canal.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      const x0 = ((pts[i][0] + 180) / 360) * w;
      const y0 = latRow(pts[i][1], h);
      const x1 = ((pts[i + 1][0] + 180) / 360) * w;
      const y1 = latRow(pts[i + 1][1], h);
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        carveDisk(mask, w, h, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), canal.r);
      }
    }
  }
}

// Биомные зоны — эллипсы с плавным затуханием влияния к краям:
// [центр lon, центр lat, радиус lon, радиус lat, сила]
type Zone = [number, number, number, number, number];

const MOUNTAINS: Zone[] = [
  // Северная Америка — Кордильеры (несколько реальных хребтов, не одна клякса)
  [-151, 63, 8, 4.5, 0.95], // Аляскинский хребет и хребет Брукса
  [-129, 57, 4.5, 7, 0.9], // Береговые хребты Канады (Британская Колумбия)
  [-116, 51, 4.5, 8, 0.9], // Канадские Скалистые горы
  [-108, 42, 4.5, 8, 0.82], // Скалистые горы США (Колорадо, Вайоминг, Монтана)
  [-120, 41, 2.3, 8.5, 0.78], // Каскадные горы и Сьерра-Невада (узкая западная гряда)
  [-104.5, 23.5, 4.5, 6.5, 0.68], // Сьерра-Мадре (Мексика)
  [-70, -22, 4.5, 32, 1.0], // Анды — узкая длинная гряда
  [10, 45.7, 5.5, 2.2, 0.9], // Альпы
  [44, 42.5, 5, 2, 0.9], // Кавказ
  [59, 58, 3, 9, 0.85], // Урал
  [85, 32.5, 16, 6, 1.05], // Гималаи и Тибет
  [100, 50, 17, 5.5, 0.65], // Алтай и Саяны
  [135, 62, 10, 7, 0.6], // Верхоянский хребет
  [49, 32, 5.5, 5.5, 0.75], // Загрос
];

const DESERTS: Zone[] = [
  [10, 23, 24, 7.5, 1.1], // Сахара
  [46, 22, 10, 8.5, 1.0], // Аравийская
  [65, 29, 7.5, 5.5, 0.85], // Иран и Тар
  [98, 41.5, 13.5, 5, 0.9], // Гоби
  [131, -25.5, 14.5, 7, 1.0], // Австралийская
  [18.5, -24, 6, 6.5, 0.9], // Калахари и Намиб
  [-69.5, -22.5, 3, 6, 0.85], // Атакама
  [-110, 31.5, 7.5, 7, 0.85], // Сонора
];

const GREENLAND: Zone = [-40, 72, 19, 11, 1.2];

// Детерминированный value-шум для рваных краёв зон местности
function hash2(ix: number, iy: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// Многослойный шум — органичные пятна вместо ровных порогов
export function fbm(x: number, y: number): number {
  return (
    vnoise(x, y) * 0.55 +
    vnoise(x * 2.3 + 37, y * 2.3 + 91) * 0.3 +
    vnoise(x * 5.1 + 11, y * 5.1 + 7) * 0.15
  );
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Влияние зоны: 1 в центре, плавно гаснет к краям и чуть дальше них
function zoneScore(zones: Zone[], lon: number, lat: number): number {
  let best = 0;
  for (const [cx, cy, rx, ry, s] of zones) {
    const dx = (lon - cx) / rx;
    const dy = (lat - cy) / ry;
    const d = Math.sqrt(dx * dx + dy * dy);
    const v = s * smoothstep(1.35, 0.55, d);
    if (v > best) best = v;
  }
  return best;
}

// Сглаживание замкнутого кольца углорезкой Чайкина: срезаем каждый угол на две
// точки (¼ и ¾ ребра). Пара итераций превращает грубый многоугольник с резкими
// углами в плавную скруглённую кривую — озёра выглядят естественно, без изломов.
function smoothRing(ring: Ring, iters = 2): Ring {
  let pts = ring;
  for (let it = 0; it < iters; it++) {
    const out: Ring = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % n];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      out.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    pts = out;
  }
  return pts;
}

// «Разворачиваем» кольцо в непрерывные долготы: убираем прыжки через 180-й
// меридиан, добавляя ±360. Так кольцо становится замкнутым в плоскости, и
// заливка по строке всегда даёт чётное число пересечений (без полос).
function unwrapRing(ring: Ring): Ring {
  const out: Ring = [[ring[0][0], ring[0][1]]];
  let prev = ring[0][0];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, ring[i][1]]);
    prev = lon;
  }
  return out;
}

// Сканлайн-заливка настоящими береговыми линиями. Долготы пар могут выходить
// за [-180,180] (для колец у 180-го меридиана) — заливаем с заворотом по краю.
function rasterize(rings: Ring[], w: number, h: number, mask: Uint8Array, value: number) {
  interface Edge { ya: number; yb: number; xa: number; xb: number }
  const edges: Edge[] = [];
  for (const raw of rings) {
    const ring = unwrapRing(raw);
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xa, ya] = ring[i];
      const [xb, yb] = ring[j];
      if (ya !== yb) edges.push({ xa, ya, xb, yb });
    }
  }
  const lons: number[] = [];
  for (let y = 0; y < h; y++) {
    const lat = rowLat(y, h);
    lons.length = 0;
    for (const e of edges) {
      const lo = Math.min(e.ya, e.yb);
      const hi = Math.max(e.ya, e.yb);
      if (lat <= lo || lat > hi) continue;
      lons.push(e.xa + ((lat - e.ya) / (e.yb - e.ya)) * (e.xb - e.xa));
    }
    lons.sort((a, b) => a - b);
    for (let k = 0; k + 1 < lons.length; k += 2) {
      // диапазон долгот [lons[k], lons[k+1]] в пиксели, с заворотом по модулю w
      const p0 = Math.ceil(((lons[k] + 180) / 360) * w - 0.5);
      const p1 = Math.floor(((lons[k + 1] + 180) / 360) * w - 0.5);
      for (let p = p0; p <= p1; p++) {
        const px = ((p % w) + w) % w;
        mask[y * w + px] = value;
      }
    }
  }
}

let cached: Uint8Array | null = null;

export function earthTerrain(): Uint8Array {
  if (cached) return new Uint8Array(cached);
  const w = EARTH_W;
  const h = EARTH_H;

  // реальные береговые линии Natural Earth 50m
  const topo = require2('world-atlas/land-50m.json');
  const { feature } = require2('topojson-client');
  const land = feature(topo, topo.objects.land);
  const geom = land.features ? land.features[0].geometry : land.geometry;
  const allRings: Ring[] = [];
  for (const poly of geom.coordinates as Ring[][]) {
    for (const ring of poly) allRings.push(ring);
  }

  const mask = new Uint8Array(w * h);
  rasterize(allRings, w, h, mask, 1);
  rasterize(LAKES.map((r) => smoothRing(r)), w, h, mask, 0); // озёра — вода, со скруглёнными берегами

  // Антарктида в данных обрывается у полюса — гарантируем сплошной ледник
  // ниже 82°ю до нижнего края карты (берег севернее рисует сам полигон)
  const y82 = latRow(-82, h);
  for (let y = Math.max(0, y82); y < h; y++) {
    for (let x = 0; x < w; x++) mask[y * w + x] = 1;
  }

  // убираем мелкие острова-«крошки» (< 16 клеток): при обзорном зуме это точки
  // в 1–3 пикселя, высаживаться на них смысла нет. Крупные острова (Крит ~22,
  // Кипр ~23, Ямайка ~24 и всё больше) остаются
  const MIN_ISLAND = 16;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let c = 0; c < w * h; c++) {
    if (!mask[c] || seen[c]) continue;
    stack.length = 0;
    stack.push(c);
    seen[c] = 1;
    const comp: number[] = [c];
    while (stack.length) {
      const cc = stack.pop()!;
      const x = cc % w;
      const tryPush = (n: number) => {
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
          comp.push(n);
        }
      };
      if (x > 0) tryPush(cc - 1);
      if (x < w - 1) tryPush(cc + 1);
      if (cc >= w) tryPush(cc - w);
      if (cc < w * h - w) tryPush(cc + w);
    }
    if (comp.length < MIN_ISLAND) {
      for (const cc of comp) mask[cc] = 0;
    }
  }

  // прорезаем реальные каналы/проливы (Суэц, Панама, Гибралтар, Босфор, Баб-эль-Мандеб)
  carveCanals(mask, w, h);

  // Классификация с ПИКСЕЛЬНЫМ смешением биомов: у каждого пикселя свой мелкий
  // дизеринг, поэтому даже равнина — зелёный с редкими вкраплениями песка/камня,
  // а границы биомов размыты по пикселям (снег+камень и т.п.), как на реальных
  // растровых картах. Всё детерминировано (hash-шум) — карта всегда одинаковая.
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = rowLat(y, h);
    for (let x = 0; x < w; x++) {
      const c = y * w + x;
      if (!mask[c]) continue;
      const lon = ((x + 0.5) / w) * 360 - 180;

      // Рельефный вид: снежные шапки на высоких горах, каменные склоны, песок в
      // пустынях, зелёные равнины. Плавно (крупный шум формы), без пиксельной
      // «каши» — мягкие переходы даёт сглаживание на клиенте.
      let snow = smoothstep(70, 80, lat) + zoneScore([GREENLAND], lon, lat);
      if (lat < -60) snow = 2;
      snow += (fbm(x / 24, y / 24) - 0.5) * 0.35;
      // Горы: доменное искажение координат рвёт гладкие эллипсы зон в изломанные
      // контуры, а ridged-шум даёт гряды/гребни (а не сплошное овальное пятно).
      const wl = lon + (fbm(x / 30 + 5, y / 30 + 9) - 0.5) * 14;
      const wt = lat + (fbm(x / 30 + 50, y / 30 + 70) - 0.5) * 9;
      const ridge = 1 - Math.abs(fbm(x / 10 + 11, y / 10 + 3) * 2 - 1); // 0..1, пики на гребнях
      let mtn = zoneScore(MOUNTAINS, wl, wt);
      mtn = mtn * (0.45 + ridge) + (fbm(x / 8 + 313, y / 8 + 77) - 0.5) * 0.45;
      // Пустыни: доменное искажение рвёт эллипсы зон в органичные контуры, крупный
      // и мелкий шум добавляет рваные края и вкрапления (оазисы/каменистые участки).
      const dl = lon + (fbm(x / 26 + 71, y / 26 + 13) - 0.5) * 16;
      const dt = lat + (fbm(x / 26 + 200, y / 26 + 90) - 0.5) * 10;
      const sand = zoneScore(DESERTS, dl, dt) + (fbm(x / 18 + 131, y / 18 + 217) - 0.5) * 0.5;

      // Снеговая линия зависит от широты: у полюсов снег на любой горе, в тропиках
      // — только на самых высоких массивах (напр. Сьерра-Невада/Мадре — камень,
      // а не белые шапки как на Аляске). |lat| 60→снег легко, |lat| 20→почти нет.
      const snowLine = 0.78 + smoothstep(56, 20, Math.abs(lat)) * 0.55;
      let t = T_GRASS;
      if (snow > 0.55) t = T_SNOW;
      else if (mtn > snowLine) t = T_SNOW; // высокие вершины по широте — снежные шапки
      else if (mtn > 0.4) t = T_ROCK; // горные склоны — камень
      else if (sand > 0.55) t = T_SAND; // пустыни — песок
      out[c] = t;
    }
  }
  cached = out;
  return new Uint8Array(cached);
}
