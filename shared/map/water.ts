// Водная модель карты: где вода, где океан, где берег и что с чем связано морем.
// Перенято из OpenFront (src/core/game/GameMap.ts — биты террейна, WaterManager,
// map-generator/map_generator.go — createMiniMap). Три идеи, которые мы берём:
//
//  1. ОКЕАН ≠ ВОДА. Вода, связанная с краем карты, — океан (у них бит 5 в байте
//     террейна); всё остальное — озёра. Корабли ходят только по океану, порт
//     ставится только на океанский берег. Без этого точку маршрута можно
//     «примагнитить» в озеро, и корабль зависает или маршрут не находится.
//  2. КОМПОНЕНТЫ СВЯЗНОСТИ ВОДЫ. Отдельный id связной водной области на клетку
//     даёт проверку «достижимо ли морем» за O(1) вместо провального обхода всей
//     карты (у них ConnectedComponents + ComponentCheckTransformer, который
//     отсекает недостижимое ДО поиска). При 293 ботах это решающая экономия.
//  3. ПРИ ОГРУБЛЕНИИ ВОДА ПОБЕЖДАЕТ. У них блок 2×2 считается водой, если в нём
//     есть ХОТЯ БЫ одна водная клетка — «Water > Impassable > Land», ровно затем,
//     чтобы узкие реки и проливы не исчезали с грубой сетки. У нас было наоборот
//     (блок 5×5 — вода только если в нём НОЛЬ суши), поэтому проливы пропадали и
//     приходилось вручную прорубать коридоры (CANALS). Обратная сторона правила:
//     грубый путь становится лишь КОРИДОРОМ-подсказкой и обязан уточняться
//     точным поиском по воде (см. Game.waterRoute) — иначе корабль срежет сушу.
//
// Реки. Когда в terrain[] появятся реки (значение 0 шириной 1–2 клетки, впадающие
// в море), всё заработает само: заливка океана поднимется по реке вверх, огрубление
// её сохранит, а уточнение проведёт корабль ровно по русл. Ничего специального для
// рек в коде не нужно — нужно лишь, чтобы река была нарисована как вода и касалась
// океана. Единственная настройка — COASTAL_PENALTY в поиске пути: он держит суда
// в открытом море, а у речных клеток «прибрежность» всегда единица, поэтому река
// используется как объезд, только если это реально короче.

export interface WaterFields {
  /** 1 = вода, связанная с краем карты (океан). Суша и озёра — 0. */
  ocean: Uint8Array;
  /** 1 = вода, НЕ связанная с океаном (озеро). */
  lake: Uint8Array;
  /** 1 = водная клетка, у которой в 4-соседстве есть суша (штраф в поиске пути). */
  coastal: Uint8Array;
  /** 1 = клетка СУШИ, у которой в 4-соседстве есть океан (берег для порта/высадки). */
  shore: Uint8Array;
  /** id связной водной области на клетку (-1 = суша). Разные id — морем не пройти. */
  waterId: Int32Array;
  /** число водных областей. */
  waterComponents: number;
}

/**
 * Разбор карты на водные поля одним проходом заливок.
 * terrain: 0 = вода, >0 = суша (тип местности).
 *
 * components: считать компоненты связности воды (waterId). Нужны только серверу
 * для проверки достижимости морем; клиенту, которому хватает shore для курсора
 * порта, эту заливку (и лишние 4 байта на клетку) считать не надо.
 */
export function buildWaterFields(
  terrain: Uint8Array,
  w: number,
  h: number,
  components = true,
): WaterFields {
  const n = w * h;
  const ocean = new Uint8Array(n);
  const lake = new Uint8Array(n);
  const coastal = new Uint8Array(n);
  const shore = new Uint8Array(n);
  const waterId = components ? new Int32Array(n).fill(-1) : new Int32Array(0);

  // --- 1. Океан: заливка воды от краёв карты (4-связность: диагональная щель
  // между двумя клетками суши не считается проходом для воды).
  const stack: number[] = [];
  const pushIfWater = (c: number) => {
    if (!terrain[c] && !ocean[c]) {
      ocean[c] = 1;
      stack.push(c);
    }
  };
  for (let x = 0; x < w; x++) {
    pushIfWater(x);
    pushIfWater((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    pushIfWater(y * w);
    pushIfWater(y * w + w - 1);
  }
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % w;
    if (x > 0) pushIfWater(c - 1);
    if (x < w - 1) pushIfWater(c + 1);
    if (c >= w) pushIfWater(c - w);
    if (c < n - w) pushIfWater(c + w);
  }

  // --- 2. Озёра, прибрежность воды и берег суши
  for (let c = 0; c < n; c++) {
    const x = c % w;
    const y = (c / w) | 0;
    const land = terrain[c] > 0;
    if (!land && !ocean[c]) lake[c] = 1;
    // соседи по 4 направлениям
    const l = x > 0 ? c - 1 : -1;
    const r = x < w - 1 ? c + 1 : -1;
    const u = y > 0 ? c - w : -1;
    const d = y < h - 1 ? c + w : -1;
    if (land) {
      // берег = суша, примыкающая именно к ОКЕАНУ (у озера порт бесполезен)
      if ((l >= 0 && ocean[l]) || (r >= 0 && ocean[r]) || (u >= 0 && ocean[u]) || (d >= 0 && ocean[d])) {
        shore[c] = 1;
      }
    } else {
      if ((l >= 0 && terrain[l]) || (r >= 0 && terrain[r]) || (u >= 0 && terrain[u]) || (d >= 0 && terrain[d])) {
        coastal[c] = 1;
      }
    }
  }

  // --- 3. Компоненты связности воды. Связность — та же, что у поиска пути:
  // 8 направлений, но диагональ запрещена, если оба ортогональных соседа — суша
  // (иначе корабль «протискивался» бы в диагональную щель между двумя мысами).
  let comp = 0;
  for (let s = 0; components && s < n; s++) {
    if (terrain[s] || waterId[s] >= 0) continue;
    const id = comp++;
    stack.length = 0;
    stack.push(s);
    waterId[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % w;
      const y = (c / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nc = ny * w + nx;
          if (terrain[nc] || waterId[nc] >= 0) continue;
          // диагональ между двумя мысами — не проход: обе ортогональные клетки
          // (nx,y) и (x,ny) не должны быть сушей одновременно
          if (dx && dy && terrain[y * w + nx] && terrain[ny * w + x]) continue;
          waterId[nc] = id;
          stack.push(nc);
        }
      }
    }
  }

  return { ocean, lake, coastal, shore, waterId, waterComponents: comp };
}

/**
 * Грубая сетка воды: блок k×k проходим, если в нём есть ХОТЯ БЫ одна клетка воды
 * («вода побеждает», как createMiniMap в OpenFront). Узкие проливы и реки
 * сохраняются. Путь по такой сетке — только коридор-подсказка: он ОБЯЗАН
 * уточняться точным поиском по воде, иначе корабль срежет сушу.
 *
 * oceanOnly: считать водой только океан — чтобы коридор не уходил через озеро.
 */
export function buildCoarseWater(
  ocean: Uint8Array,
  w: number,
  h: number,
  k: number,
  cw: number,
  ch: number,
): Uint8Array {
  const cwater = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const cy = (y / k) | 0;
    if (cy >= ch) continue;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!ocean[row + x]) continue;
      const cx = (x / k) | 0;
      if (cx < cw) cwater[cy * cw + cx] = 1; // вода побеждает — одной клетки хватает
    }
  }
  return cwater;
}

/**
 * Отрезок (x0,y0)→(x1,y1) целиком по воде? Проверка «супернакрытием»: идём по
 * всем клеткам, которые отрезок задевает, а не только по клеткам Брезенхэма —
 * иначе диагональ проскакивает угол мыса. Аналог losSmooth в OpenFront
 * (SmoothingWaterTransformer), только у них ещё учитывается «глубина» клетки.
 */
export function losWater(
  terrain: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h || terrain[y0 * w + x0]) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 4; // шаг в четверть клетки
  if (steps === 0) return true;
  let px = x0;
  let py = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t);
    const y = Math.round(y0 + dy * t);
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (terrain[y * w + x]) return false;
    // шаг оказался диагональным — обе ортогональные клетки тоже должны быть
    // водой, иначе отрезок проскакивает угол мыса по диагональной щели
    if (x !== px && y !== py && (terrain[py * w + x] || terrain[y * w + px])) return false;
    px = x;
    py = y;
  }
  return true;
}

/**
 * Спрямление пути по воде: выбрасываем промежуточные точки, пока прямой отрезок
 * между оставшимися целиком лежит на воде. Из тысяч клеток получается десяток
 * точек, и КАЖДЫЙ отрезок гарантированно морской. Порядок точек сохраняется.
 */
export function smoothWaterPath(
  terrain: Uint8Array,
  w: number,
  h: number,
  cells: number[],
): number[] {
  if (cells.length <= 2) return cells.slice();
  const out: number[] = [cells[0]];
  let anchor = 0;
  while (anchor < cells.length - 1) {
    const ax = cells[anchor] % w;
    const ay = (cells[anchor] / w) | 0;
    // Самая далёкая точка, до которой видно по воде. Ищем БИНАРНО, а не линейно:
    // линейный проход делает O(n) проверок видимости по O(n) клеток каждая, то
    // есть O(n²) на путь в тысячи клеток. Так же сделано в OpenFront
    // (SmoothingWaterTransformer.losSmooth — «binary search LOS smoothing»).
    //
    // Видимость по воде не строго монотонна (за мысом может снова «открыться»),
    // поэтому бинарный поиск может остановиться чуть раньше абсолютного
    // максимума — на пути это лишь лишняя точка перелома, но каждый отрезок
    // по-прежнему гарантированно водный.
    let lo = anchor + 1; // до соседа видно всегда (путь идёт по воде)
    let hi = cells.length - 1;
    let best = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const bx = cells[mid] % w;
      const by = (cells[mid] / w) | 0;
      if (losWater(terrain, w, h, ax, ay, bx, by)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    out.push(cells[best]);
    anchor = best;
  }
  return out;
}
