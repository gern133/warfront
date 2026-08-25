// Подключение клиентской симуляции.
//
// Воркер считает ту же партию, что сервер (из карты, seed и потока ходов), и сверяет
// хеши состояния. Режим по умолчанию — ПОЛНЫЙ LOCKSTEP: картинку берём из локальной
// симуляции, а сервер присылает только поток ходов (0.27 КБ/с против 118 КБ/с
// состояния мира). Переключается адресом страницы или localStorage:
//   sim=2 (по умолчанию) — считаем и рисуем сами;
//   sim=1 — только СВЕРКА: рисуем по данным сервера, симуляцию сверяем по хешам;
//   sim=0 — выключить воркер совсем.
//
// Здесь же живут две вещи, без которых модель нерабочая в реальной партии:
//
//   ПОЗДНЕЕ ПОДКЛЮЧЕНИЕ. Войти в идущую партию с нулевого хода нельзя: 10 000 ходов
//   пересчитывать 16 секунд, и с каждой минутой партии дольше. Вместо этого просим у
//   сервера снимок состояния и поднимаем симуляцию с него.
//
//   РЕАКЦИЯ НА РАСХОЖДЕНИЕ. Если хеши разошлись, картинке из локальной симуляции
//   верить нельзя. Раньше она просто останавливалась (в режиме sim=2 это значит
//   замерший мир). Теперь клиент берёт у сервера снимок и продолжает с него; если
//   расхождения повторяются, симуляция сдаётся и мир снова рисуется по данным
//   сервера — играть можно в любом случае.
//
// Игра не должна зависеть от того, получилось ли поднять симуляцию, поэтому любой
// сбой — не создался воркер, нет распаковки снимков, устройство не успевает счётом,
// расхождения повторяются — приводит к одному и тому же: сервер снова присылает
// состояние мира, и играть можно как раньше.
import type { Intent } from '../../shared/types/intent';
import type { SimOutMsg } from './worker';

export interface SimStats {
  enabled: boolean;
  /** Локальная симуляция — ИСТОЧНИК КАРТИНКИ (а не только сверка). В этом режиме
   *  сервер не присылает состояние мира: только поток ходов. */
  rendering: boolean;
  checked: number; // сколько ходов сверено
  desync: { turnNo: number; ours: number; theirs: number } | null;
  error: string | null;
  /** Ждём снимок с сервера: до его прихода симуляция не считает, а копит ходы. */
  awaiting: boolean;
  /** Сколько раз поднимались из снимка (позднее подключение + восстановления). */
  restored: number;
  /** Симуляция сдалась после повторных расхождений — рисуем по данным сервера. */
  gaveUp: boolean;
}

/** После скольких снимков подряд считать, что локальная симуляция не сходится.
 *  Одно восстановление — норма (позднее подключение, лаг). Три — значит расходимся
 *  систематически, и честнее вернуться к серверному состоянию, чем мигать снимками. */
const MAX_RESTORES = 3;

export class SimCheck {
  readonly stats: SimStats = {
    enabled: false,
    rendering: false,
    checked: 0,
    desync: null,
    error: null,
    awaiting: false,
    restored: 0,
    gaveUp: false,
  };
  /** Куда отдавать посчитанные локально данные для отрисовки. */
  onView: ((view: unknown) => void) | null = null;
  /** Сообщить серверу, нужно ли нам состояние мира: `true` — считаем сами, шли только
   *  ходы; `false` — верни состояние (симуляция ещё не готова, ждёт снимок или сдалась). */
  onLocalSim: ((on: boolean) => void) | null = null;
  /** Запросить у сервера снимок состояния симуляции. */
  onNeedSnapshot: (() => void) | null = null;
  /** Владельцы клеток целиком — после восстановления дельтам верить нельзя. */
  onResync: ((ownersRle: number[]) => void) | null = null;
  private worker: Worker | null = null;
  /** Чего мы хотим: 'render' — считать и рисовать самим, 'verify' — только сверять.
   *  `stats.rendering` при этом говорит, идёт ли это ПРЯМО СЕЙЧАС (в ожидании снимка
   *  и после отказа — нет). */
  private mode: 'render' | 'verify' = 'verify';
  // Запрос снимка сервер может отбить (он не собирает их чаще раза в 2 секунды) —
  // тогда без повтора воркер ждал бы вечно, копя ходы.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    let mode = '2'; // по умолчанию — считаем партию сами
    try {
      mode =
        new URLSearchParams(location.search).get('sim') ??
        localStorage.getItem('warfront.sim') ??
        '2';
    } catch {
      mode = '2'; // приватный режим — localStorage может бросать
    }
    if (mode !== '1' && mode !== '2') return; // sim=0 или мусор — воркер не поднимаем
    // Снимок состояния приходит сжатым (позднее подключение, восстановление после
    // расхождения). Без распаковки в браузере вести симуляцию самим нельзя — войти в
    // идущую партию будет невозможно; остаёмся в режиме сверки.
    if (mode === '2' && typeof DecompressionStream === 'undefined') {
      console.warn('[sim] браузер не умеет распаковывать снимки — только сверка');
      mode = '1';
    }
    this.mode = mode === '2' ? 'render' : 'verify';
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('[sim] воркер не создан, играем по данным сервера:', e);
      return;
    }
    this.stats.enabled = true;
    this.worker.onmessage = (e: MessageEvent<SimOutMsg>) => {
      const m = e.data;
      if (m.t === 'hash') this.stats.checked++;
      else if (m.t === 'desync') {
        this.stats.desync = { turnNo: m.turnNo, ours: m.ours, theirs: m.theirs };
        console.error(
          `[sim] РАСХОЖДЕНИЕ на ходу ${m.turnNo}: локально ${m.ours}, у сервера ${m.theirs}` +
            ' — берём состояние с сервера',
        );
      } else if (m.t === 'needSnapshot') {
        this.stats.awaiting = true;
        // Пока снимка нет, симуляция не считает — картинку на это время берём у
        // сервера, иначе мир замрёт на секунду-две.
        if (this.stats.rendering) {
          this.stats.rendering = false;
          this.onLocalSim?.(false);
        }
        // Больше MAX_RESTORES попыток не делаем: значит расходимся систематически.
        if (this.stats.restored >= MAX_RESTORES) {
          this.giveUp('локальная симуляция не сходится');
          return;
        }
        this.askSnapshot();
      } else if (m.t === 'slow') {
        // Устройство не успевает считать партию в реальном времени.
        this.giveUp(`симуляция не укладывается в такт (${m.avgMs.toFixed(0)} мс на ход)`);
      } else if (m.t === 'resync') {
        this.onResync?.(m.ownersRle);
      } else if (m.t === 'error') {
        this.stats.error = m.message;
        console.error('[sim] ошибка симуляции:', m.message);
      } else if (m.t === 'view') {
        if (this.stats.rendering) this.onView?.(m.view);
      } else if (m.t === 'ready') {
        // Воркер говорит «готов» только когда действительно считает партию.
        console.info(
          `[sim] локальная симуляция поднята на ходу ${m.tickNo}` +
            (this.mode === 'render' ? ' — она же источник картинки' : ' (режим сверки)'),
        );
        if (this.mode === 'render' && !this.stats.gaveUp) {
          this.stats.rendering = true;
          this.onLocalSim?.(true);
        }
      }
    };
  }

  /** Отказаться от локальной симуляции: дальше играем по данным сервера. */
  private giveUp(why: string) {
    if (this.stats.gaveUp) return;
    this.stats.gaveUp = true;
    this.stats.rendering = false;
    this.stats.awaiting = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    console.error(`[sim] ${why} — рисуем по данным сервера`);
    this.onLocalSim?.(false);
  }

  /** Попросить снимок и повторять запрос, пока он не придёт. */
  private askSnapshot() {
    this.onNeedSnapshot?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stats.awaiting && !this.stats.gaveUp) this.askSnapshot();
    }, 2500);
  }

  /** Поднять локальную симуляцию: карта, seed и сложность приходят в init.
   *  tickNo > 0 — партия уже идёт: воркер сам попросит снимок. */
  init(mapType: string, seed: number, difficulty: string, terrain: Uint8Array, tickNo = 0) {
    if (!this.worker) return;
    // копию карты отдаём переносом буфера — она большая (до 1.7 млн клеток)
    const copy = terrain.slice();
    this.worker.postMessage({ t: 'init', mapType, seed, difficulty, terrain: copy, tickNo }, [
      copy.buffer,
    ]);
  }

  /** Ход: команды этого хода (может быть пусто) — воркер применит и посчитает хеш. */
  turn(turnNo: number, intents: Intent[]) {
    this.worker?.postMessage({ t: 'turn', turnNo, intents });
  }

  /** Пачка ходов от сервера — хвост к общему снимку комнаты (см. serveSnapshot). */
  turnBatch(from: number, turns: Intent[][]) {
    this.worker?.postMessage({ t: 'turns', from, turns });
  }

  /** Хеш сервера для сверки (приходит раз в секунду). */
  check(turnNo: number, hash: number) {
    this.worker?.postMessage({ t: 'check', turnNo, hash });
  }

  /** Снимок состояния с сервера: симуляция продолжит счёт с него. */
  restore(turnNo: number, snap: unknown) {
    if (!this.worker || this.stats.gaveUp) return;
    this.stats.restored++;
    this.stats.awaiting = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stats.desync = null;
    this.worker.postMessage({ t: 'restore', turnNo, snap });
    console.info(`[sim] симуляция поднята из снимка на ходу ${turnNo}`);
  }
}
