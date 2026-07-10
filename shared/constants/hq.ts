// Штаб обороны (щит): постройка, апгрейд, зона укрепления, взрыв при захвате
export const HQ_BUILD_TICKS = 50; // время постройки (тики; 50 = 5с при 100мс)
// Прокачанный штаб при захвате взрывается через 10с с уроном по области
export const HQ_FUSE_TICKS = 100;
export const HQ_EXPLODE_RADIUS = 12;
export const MAX_HQ_LEVEL = 3;

// Апгрейд: цена и время (тики) для перехода на уровень (2 или 3)
export function hqUpgradeCost(toLevel: number): number {
  return toLevel === 2 ? 60000 : 120000;
}
export function hqUpgradeTicks(toLevel: number): number {
  return toLevel === 2 ? 50 : 100; // 5с до 2 ур., 10с до 3 ур.
}

// Цена штаба обороны растёт с каждой постройкой; потолок — 150к
const HQ_COSTS = [40000, 75000, 100000, 125000, 150000];
export function hqCost(owned: number): number {
  return HQ_COSTS[Math.min(owned, HQ_COSTS.length - 1)];
}

// Радиус защиты штаба (клетки): в этой зоне атака на владельца идёт 5:1
export const HQ_RADIUS = 16;
