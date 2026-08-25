// Сборка данных для отрисовки из состояния симуляции.
//
// Одна функция на два источника:
//   • сервер — сериализует результат в JSON и рассылает по сети (обычный режим);
//   • воркер на клиенте — считает симуляцию сам и передаёт результат в главный поток
//     через postMessage (режим локальной симуляции, как у OpenFront).
//
// Именно поэтому она лежит здесь, а не в server/index.ts: клиенту нужен тот же код,
// иначе появились бы два пути отрисовки, которые неизбежно разъедутся.
import type { Game } from './index';

export interface ViewOpts {
  /** Отдавать полный список игроков и дороги (сервер делает это раз в 500 мс). */
  sendPlayers: boolean;
  /** Полная посылка зданий вместо дельты — страховка от рассинхронизации. */
  fullBuildings: boolean;
  /** Считать хеш состояния (дорого: проход по всей карте). */
  withHash: boolean;
  speed: number;
  humans: number;
}

/** Дельты клеток RLE-серииями: [Δначало, длина, владелец, ...].
 *  Захваты идут длинными подряд-рядами (индексы клеток построчные), поэтому такой
 *  формат в ~21 раз компактнее списка пар «клетка, владелец». */
export function encodeChanges(changed: Map<number, number>): number[] {
  const out: number[] = [];
  if (!changed.size) return out;
  const sorted = [...changed.entries()].sort((a, b) => a[0] - b[0]);
  let prev = 0;
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i][0];
    const owner = sorted[i][1];
    let len = 1;
    while (i + len < sorted.length && sorted[i + len][0] === start + len && sorted[i + len][1] === owner) len++;
    out.push(start - prev, len, owner);
    prev = start;
    i += len;
  }
  return out;
}

/** Данные для отрисовки за один ход. Побочный эффект: очищает разовые события
 *  (изменённые клетки, взрывы дронов, выплаты трейда) — они уже попали в результат. */
export function buildView(game: Game, o: ViewOpts) {
  const changes = encodeChanges(game.changed);
  game.changed.clear();
  const bd = game.buildingsDelta(o.fullBuildings);
  const view = {
    type: 'update' as const,
    changes,
    // Динамика игроков — раз в 500 мс (клиент всё равно показывает армии и золото не
    // чаще), статика (имена, флаги) — только когда набор игроков изменился.
    players: o.sendPlayers ? game.playersPub() : [],
    playersMeta: o.sendPlayers ? game.playersMetaPub() : undefined,
    attacks: game.attacksPub(),
    boats: game.boatsPub(),
    // Здания — дельтой: только изменившиеся записи и id исчезнувших.
    buildings: bd.flat,
    buildingsGone: bd.gone.length ? bd.gone : undefined,
    buildingsFull: bd.full || undefined,
    ships: game.tradeShipsPub(),
    trucks: game.trucksPub(),
    roads: o.sendPlayers ? game.roadsPubIfChanged() ?? undefined : undefined,
    warships: game.warshipsPub(),
    drones: game.dronesPub(),
    droneBlasts: game.droneBlasts,
    shots: game.bulletsPub(),
    missiles: game.missilesPub(),
    earnings: game.tradeEarnings,
    // Поток ходов: команды хода и хеш состояния после него. В модели lockstep этого
    // достаточно, чтобы клиент вёл симуляцию сам.
    turn: game.turnLog[game.tickNo - 1] ?? [],
    turnNo: game.tickNo - 1,
    hash: o.withHash ? game.stateHash() : undefined,
    speed: o.speed,
    humans: o.humans,
  };
  game.tradeEarnings = []; // события уже в результате — сбрасываем
  game.droneBlasts = [];
  return view;
}
