export const CITY_BUILD_TICKS = 50; // 5с на постройку

// ПОСТРОЙКА нового города: цена по числу уже построенных, ограниченная (не должна
// раздуваться) — 50к, 75к, 100к, 150к, 200к, дальше 250к.
const CITY_BUILD_COSTS = [50000, 75000, 100000, 150000, 200000, 250000];
export function cityCost(ownedCities: number): number {
  return CITY_BUILD_COSTS[Math.min(Math.max(0, ownedCities), CITY_BUILD_COSTS.length - 1)];
}

// ГРЕЙД города: ПРОГРЕССИВНАЯ цена — растёт с уровнем, как и прирост войск (чтобы
// не было дисбаланса: чем выше уровень, тем больше войск И тем дороже апгрейд).
// toLevel — целевой уровень: 50000·L·(L−1) → 2→100к, 3→300к, 4→600к, 5→1млн,
// 6→1.5млн, 7→2.1млн, … (шаг сам растёт).
export function cityUpgradeCost(toLevel: number): number {
  return 50000 * toLevel * (toLevel - 1);
}

// Прибавка к максимуму войск от города данного уровня. Каждый следующий уровень
// даёт на 10к больше, чем предыдущий (прирост растёт): +10к, +20к, +30к, …
// Итого суммарно = 10000·level·(level+1)/2. Ур.1=10к, 2=30к, 3=60к, 4=100к, 5=150к.
export function cityTroopBonus(level: number): number {
  return 10000 * (level * (level + 1)) / 2;
}
