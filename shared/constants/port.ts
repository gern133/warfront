// Торговый порт и экономика трейда
export const PORT_BUILD_COST = 50000; // цена первого порта (база)
// Цена постройки НОВОГО порта растёт с числом уже имеющихся портов:
// 1-й 50к, 2-й 75к, 3-й 100к, 4-й 150к, 5-й 200к, 6-й и далее — 250к.
const PORT_COSTS = [50000, 75000, 100000, 150000, 200000, 250000];
export function portCost(owned: number): number {
  return PORT_COSTS[Math.min(Math.max(0, owned), PORT_COSTS.length - 1)];
}
export const PORT_BUILD_TICKS = 50; // 5с
export const PORT_SHIP_INTERVAL = 70; // корабль раз в 7с (на 1 ур. — 1 корабль)
export const PORT_MAX_SHIP_LEVEL = 30; // после 30 ур. число кораблей не растёт
export const TRADE_BASE_VALUE = 20000; // деньги за заход в порт (1 ур.)
export const PORT_RADIUS = 10; // клик в этом радиусе от порта — апгрейд, а не новый

export function portUpgradeCost(toLevel: number): number {
  return 30000 * (toLevel - 1); // до 2 ур. — 30к, до 3 — 60к, ...
}
export function tradeValue(level: number): number {
  // +3% за уровень (и до 30, и после — так растёт «прайс доставки»)
  return TRADE_BASE_VALUE * Math.pow(1.03, level - 1);
}
export function shipsForLevel(level: number): number {
  return Math.min(level, PORT_MAX_SHIP_LEVEL);
}
