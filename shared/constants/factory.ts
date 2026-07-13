import { SAM_RANGE } from './sam';

// --- Завод (клавиша 2) ---
// Добывает золото на суше и ускоряет пополнение армии в своём радиусе. Радиус —
// как у ПВО. Постройка 10с, апгрейд мгновенный и бесконечный (как у городов).
export const FACTORY_BUILD_TICKS = 100; // 10с на постройку
export const FACTORY_RANGE = SAM_RANGE; // радиус зоны действия (усиление + дороги)

// Цена «в общем» по суммарному уровню всех заводов: 125к, 250к, 500к, дальше 1млн
const FACTORY_COSTS = [125000, 250000, 500000, 1000000];
export function factoryCost(ownedLevels: number): number {
  return FACTORY_COSTS[Math.min(Math.max(0, ownedLevels), FACTORY_COSTS.length - 1)];
}

// доход завода за тик (растёт с уровнем)
export function factoryIncome(level: number): number {
  return 8 + level * 2;
}

// ускорение регена: базово +10%, +3% за каждые 10 уровней; действует на первые
// 30к войск на каждый завод (у больших армий буст слабее)
export function factoryBoostPct(level: number): number {
  return 0.1 + 0.03 * Math.floor(level / 10);
}
export const FACTORY_COVER = 30000; // войск, которые «покрывает» один завод
