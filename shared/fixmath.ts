// Детерминированная математика для СИМУЛЯЦИИ.
//
// Зачем. В модели lockstep симуляцию считает каждый клиент у себя, и одинаковые
// входные данные обязаны давать побитово одинаковый результат — иначе партии
// разъезжаются. IEEE-754 задаёт ТОЧНО только базовые операции: `+ - * /`, `sqrt`,
// округления, побитовые. А вот `Math.pow/sin/cos/atan2/hypot/exp/log` стандарт
// оставляет на усмотрение движка: «implementation-approximated». V8, JavaScriptCore и
// SpiderMonkey берут их из разных библиотек, и последний бит у них расходится.
//
// На практике это выглядит так: два игрока в одной партии, один в Chrome, другой в
// Safari — и через несколько минут у них разные позиции дронов, а дальше и разные
// захваты. Снимок состояния такое лечит (см. docs/determinism.md), но лечить это
// каждые пару минут — не дело.
//
// Поэтому здесь свои реализации, собранные ТОЛЬКО из точных операций и рядов с
// ФИКСИРОВАННЫМ числом членов. Фиксированным — это важно: критерий выхода вида
// «пока не сойдётся» сам по себе зависит от точности промежуточных значений.
//
// Точность против Math.*: относительная ошибка порядка 1e-15 (проверяется тестом).
// Она не обязана быть нулевой — от неё зависит только баланс, а не корректность.
// Требование ровно одно: результат одинаков на любом движке.
//
// Что НЕ покрыто и почему: генерация карты (`shared/map/mapmath.ts`) считает шум
// через `Math.sin` с огромными аргументами, но она выполняется только на сервере —
// клиент получает готовую карту в `init` и сам её никогда не строит.

const LN2 = 0.6931471805599453;
const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Квадрат. Оператор `**` и `Math.pow` спецификация тоже относит к приближённым, и
 *  хотя все движки для показателя 2 считают точно, полагаться на это незачем:
 *  одно умножение по IEEE-754 округляется однозначно. */
export function sq(x: number): number {
  return x * x;
}

/** Длина вектора. `sqrt` по стандарту вычисляется точно, поэтому это уже
 *  детерминированно — в отличие от `Math.hypot`, который движки реализуют
 *  по-разному (там ещё и защита от переполнения, нам не нужная). */
export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** 2^k точно: умножение на степени двойки не теряет ни бита. */
function pow2(k: number): number {
  let r = 1;
  let n = k < 0 ? -k : k;
  let b = 2;
  while (n > 0) {
    if (n & 1) r *= b;
    b *= b;
    n >>= 1;
  }
  return k < 0 ? 1 / r : r;
}

/** Натуральный логарифм. x = m·2^e, m ∈ [1,2) — разложение точное (умножения на 2).
 *  Дальше ряд для atanh: ln(m) = 2·(z + z³/3 + z⁵/5 + …), z = (m−1)/(m+1), |z| ≤ 1/3,
 *  поэтому 20 членов дают запас по точности с большим избытком. */
export function dlog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  let m = x;
  let e = 0;
  while (m >= 2) {
    m /= 2;
    e++;
  }
  while (m < 1) {
    m *= 2;
    e--;
  }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let s = 0;
  for (let k = 39; k >= 1; k -= 2) s = 1 / k + z2 * s;
  return e * LN2 + 2 * z * s;
}

/** Экспонента. x = k·ln2 + r, |r| ≤ ln2/2 — на таком r ряд Тейлора из 16 членов
 *  даёт полную двойную точность, а 2^k домножается точно. */
export function dexp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let s = 1;
  for (let n = 16; n >= 1; n--) s = 1 + (s * r) / n;
  return s * pow2(k);
}

/** Степень. Целые и полуцелые показатели считаем умножениями и корнем — это и
 *  точнее, и быстрее общего пути; остальное через exp(y·ln x). */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  // целый показатель — быстрое возведение в степень (например 1.03^level)
  if (y === Math.round(y) && y > -1024 && y < 1024) return powInt(x, y);
  // полуцелый — целая часть умножениями плюс корень (например level^1.5)
  const y2 = y * 2;
  if (y2 === Math.round(y2) && y2 > -2048 && y2 < 2048 && x > 0) {
    const half = (y2 - (y2 % 2)) / 2;
    return powInt(x, half) * Math.sqrt(x);
  }
  if (x < 0) return NaN;
  return dexp(y * dlog(x));
}

function powInt(x: number, n: number): number {
  let r = 1;
  let b = x;
  let k = n < 0 ? -n : n;
  while (k > 0) {
    if (k & 1) r *= b;
    b *= b;
    k >>= 1;
  }
  return n < 0 ? 1 / r : r;
}

/** Синус. Аргумент приводим к [0, 2π) вычитанием кратного (`floor` точен), затем к
 *  [0, π/2] по тождествам и считаем рядом Тейлора.
 *  Для больших аргументов приведение теряет точность — в симуляции таких нет
 *  (углы накапливаются по шагу и сворачиваются, см. wrapAngle). */
export function dsin(x: number): number {
  return sinCore(reduce(x));
}

export function dcos(x: number): number {
  return sinCore(reduce(x + HALF_PI));
}

/** Свернуть накопленный угол в [0, 2π): без этого у долгоживущих объектов (патруль
 *  корабля крутится тысячи тиков) аргумент растёт, а с ним и ошибка приведения. */
export function wrapAngle(a: number): number {
  return a - TWO_PI * Math.floor(a / TWO_PI);
}

function reduce(x: number): number {
  return x - TWO_PI * Math.floor(x / TWO_PI); // [0, 2π)
}

function sinCore(t: number): number {
  // симметрии: sin(π−t) = sin(t), sin(t+π) = −sin(t) — сводим к [0, π/2]
  let sign = 1;
  if (t > PI) {
    t -= PI;
    sign = -1;
  }
  if (t > HALF_PI) t = PI - t;
  // ряд Тейлора вокруг нуля: |t| ≤ π/2, 12 членов — на восьми остаточный член
  // t²⁸/17! даёт ещё 4e-14, что видно в тесте точности
  const t2 = t * t;
  let s = 1;
  for (let k = 12; k >= 1; k--) {
    const d = (2 * k) * (2 * k + 1);
    s = 1 - (t2 * s) / d;
  }
  return sign * t * s;
}

/** Арктангенс отношения. Аргумент дважды уменьшаем тождеством
 *  atan(z) = 2·atan(z / (1 + √(1+z²))) — после двух шагов |z| ≤ 0.2, и ряд Тейлора
 *  из 12 членов сходится быстро (у ряда для atan сходимость плохая только у |z| ≈ 1). */
export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? HALF_PI : -HALF_PI;
  const a = atanAbs(Math.abs(y) / Math.abs(x));
  if (x > 0) return y >= 0 ? a : -a;
  return y >= 0 ? PI - a : a - PI;
}

function atanAbs(z: number): number {
  if (!(z < Infinity)) return HALF_PI;
  if (z > 1) return HALF_PI - atanSmall(1 / z);
  return atanSmall(z);
}

function atanSmall(z: number): number {
  // два половинных шага: |z| ≤ 1 → ≤ 0.414 → ≤ 0.199
  const h1 = z / (1 + Math.sqrt(1 + z * z));
  const h2 = h1 / (1 + Math.sqrt(1 + h1 * h1));
  const t2 = h2 * h2;
  let s = 0;
  for (let k = 23; k >= 1; k -= 2) s = 1 / k - t2 * s;
  return 4 * h2 * s;
}
