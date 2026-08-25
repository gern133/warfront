// Клиентская симуляция в Web Worker — этап 3 перехода на модель OpenFront.
//
// Идея их netcode: сервер рассылает не состояние мира, а только поток ХОДОВ (команды
// игроков), а симуляцию считает каждый клиент у себя. Здесь ровно это и происходит:
// воркер получает карту, seed и сложность, поднимает ту же самую `Game`, что крутится
// на сервере, и применяет приходящие ходы.
//
// Симуляция тяжёлая (1.6 мс на тик при 293 странах), и главный поток рисует кадры —
// поэтому она и живёт в воркере: их главный поток тоже занят только рендером.
//
// Два режима: сверка (рисуем по данным сервера, локальную симуляцию только сверяем по
// хешу) и источник картинки (сервер присылает лишь поток ходов).
//
// Партию не всегда можно начать с нулевого хода, поэтому есть ещё СНИМОК:
//   • позднее подключение — вход в идущую партию (10 000 ходов пересчитывать 16 с);
//   • расхождение — если хеши разошлись, продолжать врать картинкой нельзя.
// В обоих случаях воркер ждёт снимок, а приходящие тем временем ходы складывает в
// очередь и применяет их после восстановления.
import { Game } from '../../server/game/index';
import { buildView } from '../../server/game/view';
import { rleEncode } from '../../shared/rle';
import type { Intent } from '../../shared/types/intent';
import type { GameSnapshot } from '../../server/game/types';
import type { Difficulty, MapType } from '../../shared/protocol';

type InMsg =
  | {
      t: 'init';
      mapType: MapType;
      seed: number;
      difficulty: Difficulty;
      terrain: Uint8Array;
      tickNo: number;
    }
  | { t: 'turn'; turnNo: number; intents: Intent[] }
  | { t: 'check'; turnNo: number; hash: number }
  // пачка ходов от сервера: хвост от общего снимка до «сейчас» (см. serveSnapshot)
  | { t: 'turns'; from: number; turns: Intent[][] }
  | { t: 'restore'; turnNo: number; snap: GameSnapshot };

export type SimOutMsg =
  | { t: 'ready'; tickNo: number }
  | { t: 'hash'; turnNo: number; hash: number }
  // данные для отрисовки — тот же формат, что присылает сервер, поэтому главный
  // поток применяет их существующим кодом (см. buildView)
  | { t: 'view'; view: unknown }
  // владельцы клеток целиком: после восстановления из снимка дельтам верить нельзя
  | { t: 'resync'; ownersRle: number[] }
  // симуляции нужно состояние с сервера (вход в идущую партию или расхождение)
  | { t: 'needSnapshot'; reason: 'late' | 'desync' | 'gap' }
  // устройство не успевает считать симуляцию в реальном времени
  | { t: 'slow'; avgMs: number }
  // расхождение симуляций: дальше локальной картинке верить нельзя
  | { t: 'desync'; turnNo: number; ours: number; theirs: number }
  | { t: 'error'; message: string };

let game: Game | null = null;
// хеши по номерам ходов — сервер присылает свой раз в секунду, сверяем по номеру
const hashes = new Map<number, number>();
let ticks = 0;
let firstView = true; // первую посылку зданий отдаём целиком, дальше дельтами
// Ждём снимок с сервера: считать нельзя, но ходы копим — после восстановления они
// продолжат партию с того места, где снимок был снят.
let awaiting = false;
const queue: { turnNo: number; intents: Intent[] }[] = [];
const QUEUE_MAX = 600; // минута ходов; дальше снимок всё равно уже неактуален
// Успевает ли устройство считать симуляцию в реальном времени. Ход приходит раз в
// 100 мс; если счёт стоит дороже, сообщения копятся в очереди воркера, картинка
// незаметно отстаёт всё сильнее — лучше честно вернуться к состоянию от сервера.
let costSum = 0;
let costN = 0;
let slowSent = false;
const SLOW_MS = 45; // почти половина бюджета хода — дальше запас уже не отыграть

const post = (m: SimOutMsg) => (self as unknown as Worker).postMessage(m);

/** Один ход: применить команды, посчитать состояние и отдать картинку наверх. */
function runTurn(turnNo: number, intents: Intent[]): boolean {
  if (!game) return false;
  // Ходы обязаны применяться подряд: пропуск означает, что мы отстали, и
  // симуляция уже несопоставима с серверной — спасаемся снимком.
  if (turnNo !== game.tickNo) {
    awaiting = true;
    post({ t: 'needSnapshot', reason: 'gap' });
    return false;
  }
  const t0 = performance.now();
  for (const i of intents) game.enqueue(i);
  game.tick();
  ticks++;
  post({
    t: 'view',
    view: buildView(game, {
      sendPlayers: ticks % 5 === 0,
      fullBuildings: firstView,
      withHash: false, // хеш считаем отдельно и реже — он дорогой
      speed: 1,
      humans: 1,
    }),
  });
  firstView = false;
  if (ticks % 10 === 0) {
    const h = game.stateHash();
    hashes.set(turnNo, h);
    post({ t: 'hash', turnNo, hash: h });
  }
  // старые хеши не держим
  if (hashes.size > 64) for (const k of hashes.keys()) { if (k < turnNo - 32) hashes.delete(k); }
  costSum += performance.now() - t0;
  if (++costN >= 50) {
    const avg = costSum / costN;
    costSum = 0;
    costN = 0;
    if (avg > SLOW_MS && !slowSent) {
      slowSent = true;
      post({ t: 'slow', avgMs: avg });
    }
  }
  return true;
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.t === 'init') {
      // Карта приходит готовой: генерировать её на клиенте нельзя (для Земли это
      // чтение файлов Natural Earth), да и не нужно — сервер уже прислал.
      game = new Game(msg.mapType, msg.seed, msg.terrain);
      game.addBots(msg.difficulty);
      hashes.clear();
      queue.length = 0;
      ticks = 0;
      firstView = true;
      // ПОЗДНЕЕ ПОДКЛЮЧЕНИЕ: партия уже идёт, с нулевого хода её не догнать —
      // просим снимок и до его прихода только копим ходы.
      awaiting = msg.tickNo > 0;
      // «Готов» говорим только когда симуляция действительно считает: иначе главный
      // поток решит, что картинку можно брать у нас, и мир замрёт до снимка.
      if (awaiting) post({ t: 'needSnapshot', reason: 'late' });
      else post({ t: 'ready', tickNo: game.tickNo });
      return;
    }
    if (!game) return;
    if (msg.t === 'restore') {
      game.restore(msg.snap);
      hashes.clear();
      awaiting = false;
      firstView = true; // здания после восстановления — целиком
      // Владельцы клеток у главного потока накопились из дельт и теперь могут не
      // сходиться с восстановленным состоянием — отдаём их целиком.
      post({ t: 'resync', ownersRle: rleEncode(game.owners) });
      // Ходы, пришедшие пока снимок ехал: применяем те, что после него.
      const pending = queue.filter((q) => q.turnNo >= game!.tickNo).sort((a, b) => a.turnNo - b.turnNo);
      queue.length = 0;
      for (const q of pending) {
        // хвост от сервера и собственная очередь перекрываются — уже применённые
        // ходы просто пропускаем, иначе runTurn увидел бы разрыв и запросил всё заново
        if (q.turnNo < game.tickNo) continue;
        if (!runTurn(q.turnNo, q.intents)) break;
      }
      if (!awaiting) post({ t: 'ready', tickNo: game.tickNo });
      return;
    }
    if (msg.t === 'turns') {
      // Снимок общий на комнату и может быть на пару секунд старше нашего запроса —
      // это хвост, закрывающий разрыв. Складываем туда же, в очередь: она всё равно
      // разбирается после восстановления и пропускает уже применённое.
      for (let i = 0; i < msg.turns.length; i++) {
        queue.push({ turnNo: msg.from + i, intents: msg.turns[i] });
      }
      while (queue.length > QUEUE_MAX) queue.shift();
      return;
    }
    if (msg.t === 'turn') {
      if (awaiting) {
        queue.push(msg);
        if (queue.length > QUEUE_MAX) queue.shift();
        return;
      }
      runTurn(msg.turnNo, msg.intents);
      return;
    }
    if (msg.t === 'check') {
      if (awaiting) return;
      const ours = hashes.get(msg.turnNo);
      if (ours === undefined) return; // этот ход мы ещё/уже не держим
      if (ours !== msg.hash) {
        // РАСХОЖДЕНИЕ. Раньше здесь симуляция просто останавливалась; теперь она
        // просит у сервера снимок и продолжает с него, а до тех пор копит ходы.
        awaiting = true;
        post({ t: 'desync', turnNo: msg.turnNo, ours, theirs: msg.hash });
        post({ t: 'needSnapshot', reason: 'desync' });
      }
      return;
    }
  } catch (err) {
    // Сбой на тике — тоже повод взять состояние с сервера (число попыток ограничено
    // на стороне SimCheck, поэтому зацикливания не будет).
    awaiting = true;
    post({ t: 'error', message: String(err) });
    post({ t: 'needSnapshot', reason: 'desync' });
  }
};
