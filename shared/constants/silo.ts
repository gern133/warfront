import { HQ_EXPLODE_RADIUS } from './hq';

// --- Ракетная шахта и ядерные ракеты ---
// Шахта (клавиша 5): постройка и апгрейд по 1млн, оба за 5с. Уровень = размер
// «залпа» (сколько ракет можно выпустить подряд). После пуска перезаряжается
// по 1 ракете раз в 5с до потолка (= уровень).
export const SILO_COST = 1_000_000; // и постройка, и апгрейд
export const SILO_BUILD_TICKS = 50; // 5с
export const SILO_RELOAD_TICKS = 50; // +1 ракета в залп раз в 5с

// Типы ракет (пуск с клавиши 8 и далее). Радиус/урон/цена варьируются по типу —
// заложено на будущее (пока одна «базовая»). armyFrac — доля армии, сносимая
// взрывом у задетого. Время полёта зависит от расстояния: dist/speed тиков,
// зажатое в [minFlight, maxFlight].
export interface NukeSpec {
  name: string;
  cost: number;
  radius: number; // радиус взрыва в клетках
  armyFrac: number; // доля армии, сносимая у задетых
  speed: number; // клеток за тик (баллистическая скорость)
  minFlight: number; // не быстрее (близкие цели)
  maxFlight: number; // не дольше (дальние цели)
}
export const NUKES: Record<string, NukeSpec> = {
  basic: {
    name: 'Ядерная ракета',
    cost: 750_000,
    radius: HQ_EXPLODE_RADIUS * 2, // как взрыв 3-го тира щита
    armyFrac: 0.25, // сносит 25% армии
    speed: 12, // клеток/тик
    minFlight: 25, // ~2.5с минимум
    maxFlight: 140, // ~14с максимум (через всю карту)
  },
};

// Время полёта ракеты по расстоянию (тики), зажатое мин/макс
export function nukeFlightTicks(spec: NukeSpec, dist: number): number {
  return Math.max(spec.minFlight, Math.min(spec.maxFlight, Math.round(dist / spec.speed)));
}
