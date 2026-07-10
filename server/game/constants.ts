import { Difficulty } from '../../shared/protocol';

// Скорости движения кружков (клеток за тик)
export const TRADE_SPEED = 0.6;
export const BOAT_SPEED = 0.6;

// Случайная карта и общий баланс симуляции
export const RANDOM_W = 560;
export const RANDOM_H = 560;
export const LAND_RATIO = 0.5;
export const SPAWN_TROOPS = 600;
export const NEUTRAL_COST = 1.4;
// Рост замедляется, когда войск больше 70% от максимума (за 30% до потолка)
export const GROWTH_SLOW_FROM = 0.7;
// Доля фронта, захватываемая за тик — задаёт «постепенность» движения границы
export const WAVE_SPEED = 0.15;

// Слабые племена — пассивный «корм»: их всегда 275, они растут вдвое медленнее
// игрока, имеют втрое меньший потолок и лишь расширяются в нейтраль. Страны
// (25 штук) — полноценные противники; сложность задаёт их силу относительно
// игрока и агрессивность.
export const WEAK_COUNT = 275;
export const STRONG_COUNT = 25;
export const WEAK_GROWTH = 0.5; // вдвое медленнее игрока
export const WEAK_MAX = 1 / 3; // потолок войск втрое меньше

export const DIFFICULTY: Record<Difficulty, { strongMul: number; aggro: number }> = {
  easy: { strongMul: 0.8, aggro: 0.7 }, // страны слабее игрока
  normal: { strongMul: 1.0, aggro: 1.0 }, // как игрок
  hard: { strongMul: 1.2, aggro: 1.25 }, // на 20% сильнее
  insane: { strongMul: 1.5, aggro: 1.6 }, // на 50% сильнее
};

// Слабые боты: случайные имена из сочетаний (нужно >= WEAK_COUNT комбинаций)
const NAME_ADJ = [
  'Дикие', 'Лесные', 'Степные', 'Горные', 'Северные', 'Южные', 'Багровые',
  'Чёрные', 'Золотые', 'Серые', 'Огненные', 'Ледяные', 'Тёмные', 'Вольные',
  'Древние', 'Кровавые', 'Туманные', 'Речные', 'Пустынные', 'Небесные',
];
const NAME_NOUN = [
  'Волки', 'Вороны', 'Медведи', 'Змеи', 'Ястребы', 'Кабаны', 'Лисы', 'Быки',
  'Драконы', 'Шакалы', 'Тигры', 'Барсы', 'Грифы', 'Псы', 'Рыси', 'Соколы',
  'Скорпионы', 'Пантеры',
];

export const STRONG_NAMES = [
  '🇺🇸 США', '🇨🇳 Китай', '🇷🇺 Россия', '🇩🇪 Германия', '🇬🇧 Британия',
  '🇫🇷 Франция', '🇯🇵 Япония', '🇹🇷 Турция', '🇮🇳 Индия', '🇧🇷 Бразилия',
  '🇨🇦 Канада', '🇦🇺 Австралия', '🇪🇸 Испания', '🇮🇹 Италия', '🇲🇽 Мексика',
  '🇰🇷 Корея', '🇮🇩 Индонезия', '🇸🇦 Аравия', '🇦🇷 Аргентина', '🇵🇱 Польша',
  '🇳🇱 Нидерланды', '🇸🇪 Швеция', '🇨🇭 Швейцария', '🇳🇴 Норвегия', '🇺🇦 Украина',
  '🇪🇬 Египет', '🇿🇦 ЮАР', '🇳🇬 Нигерия', '🇵🇰 Пакистан', '🇻🇳 Вьетнам',
  '🇹🇭 Таиланд', '🇬🇷 Греция', '🇵🇹 Португалия', '🇨🇿 Чехия', '🇭🇺 Венгрия',
  '🇫🇮 Финляндия', '🇩🇰 Дания', '🇮🇪 Ирландия', '🇮🇱 Израиль', '🇰🇿 Казахстан',
];

export function pickShuffled(names: string[], n: number): string[] {
  const pool = [...names];
  const out: string[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  }
  return out;
}

export function weakNames(n: number): string[] {
  const combos: string[] = [];
  for (const a of NAME_ADJ) for (const b of NAME_NOUN) combos.push(`${a} ${b}`);
  return pickShuffled(combos, n);
}

// Сглаживание ломаной (углы срезаются по Чайкину), концы сохраняются
export function chaikin(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const out: number[] = [pts[0], pts[1]];
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const bx = pts[(i + 1) * 2];
    const by = pts[(i + 1) * 2 + 1];
    out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25);
    out.push(ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
