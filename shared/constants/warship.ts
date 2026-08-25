// Боевой корабль: здоровье, опыт и звания.
//
// Опыт («попадания») копится ТОЛЬКО за попадания по чужим БОЕВЫМ кораблям —
// трейдеры, десант и дроны не считаются, иначе ранг набивался бы на беззащитных
// целях. Каждое попадание поднимает максимальное здоровье на WARSHIP_XP_HP_GAIN,
// а на кратностях WARSHIP_RANK_MULTS корабль получает очередное звание.
//
// Порог звания в попаданиях = (кратность − 1) / WARSHIP_XP_HP_GAIN:
//   ×1.5 → 10 попаданий   (Лейтенант)
//   ×3   → 40             (Капитан)
//   ×6   → 100            (Коммодор)
//   ×10  → 180            (Адмирал)
// При WARSHIP_DAMAGE = 25 и базовых 100 HP четыре попадания топят новичка, то есть
// первое звание — примерно два-три сбитых корабля, последнее — несколько десятков.
export const WARSHIP_HP = 100; // здоровье новичка (звание «Матрос»)
export const WARSHIP_XP_HP_GAIN = 0.05; // +5% макс. здоровья за попадание

export const WARSHIP_RANK_MULTS = [1.5, 3, 6, 10] as const;
export const WARSHIP_RANK_NAMES = [
  'Матрос',
  'Лейтенант',
  'Капитан',
  'Коммодор',
  'Адмирал',
] as const;
export const WARSHIP_MAX_RANK = WARSHIP_RANK_MULTS.length; // 4 золотые полоски

export function warshipHpMult(xp: number): number {
  return 1 + Math.max(0, xp) * WARSHIP_XP_HP_GAIN;
}

export function warshipMaxHp(xp: number): number {
  return Math.round(WARSHIP_HP * warshipHpMult(xp));
}

/** 0 — без знаков различия, дальше по числу пройденных кратностей (1..4). */
export function warshipRank(xp: number): number {
  const mult = warshipHpMult(xp);
  let rank = 0;
  for (const t of WARSHIP_RANK_MULTS) {
    if (mult < t) break;
    rank++;
  }
  return rank;
}

export function warshipRankName(xp: number): string {
  return WARSHIP_RANK_NAMES[warshipRank(xp)];
}

/** Сколько попаданий нужно на это звание (для прогресса в интерфейсе). */
export function warshipXpForRank(rank: number): number {
  const t = WARSHIP_RANK_MULTS[rank - 1];
  return t === undefined ? 0 : Math.ceil((t - 1) / WARSHIP_XP_HP_GAIN);
}

// ПВО боевого корабля. Со второго звания («Капитан») корабль умеет сбивать дроны в
// своём радиусе стрельбы, и каждое следующее звание даёт ещё один заряд:
//   Капитан  — 1 заряд
//   Коммодор — 2
//   Адмирал  — 3
// Заряды считаются как у зенитной установки: массив тиков восстановления, по одному
// перехватчику на дрон.
export const WARSHIP_AA_FROM_RANK = 2;
export const WARSHIP_AA_RELOAD_TICKS = 70; // 7с на восстановление заряда

export function warshipAaCharges(xp: number): number {
  const rank = warshipRank(xp);
  return rank < WARSHIP_AA_FROM_RANK ? 0 : rank - WARSHIP_AA_FROM_RANK + 1;
}
