// Подключение клиентской симуляции.
//
// Воркер считает ту же партию, что сервер (из карты, seed и потока ходов), и сверяет
// хеши состояния. Два режима:
//   sim=1 — только СВЕРКА: рисуем по данным сервера, локальную симуляцию сверяем.
//   sim=2 — полный lockstep: рисуем по локальной симуляции, сервер присылает только
//           поток ходов (0.27 КБ/с против 118 КБ/с состояния мира).
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
// Включается флагом, чтобы работающая игра от воркера не зависела:
//   • в адресе страницы: ?sim=1
//   • или в консоли: localStorage.setItem('warfront.sim', '1')
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
  /** Сообщить серверу, что состояние мира нам больше не нужно. */
  onReady: (() => void) | null = null;
  /** Запросить у сервера снимок состояния симуляции. */
  onNeedSnapshot: (() => void) | null = null;
  /** Владельцы клеток целиком — после восстановления дельтам верить нельзя. */
  onResync: ((ownersRle: number[]) => void) | null = null;
  /** Симуляция сдалась: снова рисуем по данным сервера (и просим их присылать). */
  onGiveUp: (() => void) | null = null;
  private worker: Worker | null = null;
  // Запрос снимка сервер может отбить (он не собирает их чаще раза в 2 секунды) —
  // тогда без повтора воркер ждал бы вечно, копя ходы.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    let mode = '';
    try {
      mode =
        new URLSearchParams(location.search).get('sim') ??
        localStorage.getItem('warfront.sim') ??
        '';
    } catch {
      mode = ''; // приватный режим — localStorage может бросать
    }
    if (mode !== '1' && mode !== '2') return;
    this.stats.rendering = mode === '2';
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
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
        // Больше MAX_RESTORES попыток не делаем: значит расходимся систематически.
        if (this.stats.restored >= MAX_RESTORES) {
          if (!this.stats.gaveUp) {
            this.stats.gaveUp = true;
            this.stats.rendering = false;
            console.error('[sim] локальная симуляция не сходится — рисуем по данным сервера');
            this.onGiveUp?.();
          }
          return;
        }
        this.askSnapshot();
      } else if (m.t === 'resync') {
        this.onResync?.(m.ownersRle);
      } else if (m.t === 'error') {
        this.stats.error = m.message;
        console.error('[sim] ошибка симуляции:', m.message);
      } else if (m.t === 'view') {
        if (this.stats.rendering) this.onView?.(m.view);
      } else if (m.t === 'ready') {
        console.info(
          `[sim] локальная симуляция поднята на ходу ${m.tickNo}` +
            (this.stats.rendering ? ' — она же источник картинки' : ' (режим сверки)'),
        );
        if (this.stats.rendering) this.onReady?.();
      }
    };
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
