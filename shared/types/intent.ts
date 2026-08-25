// Команда игрока («интент») — единственный способ повлиять на симуляцию извне.
//
// Это шаг к модели OpenFront: там сервер рассылает не состояние мира, а только
// упорядоченные по ходам команды (`Turn { turnNumber, intents[], hash }`), и симуляцию
// считает каждый клиент у себя. Чтобы это стало возможным, все внешние воздействия
// обязаны быть (а) описаны данными, (б) применяться в строго определённом порядке и в
// строго определённый ход.
//
// Здесь ТОЛЬКО детерминированная часть: ни сокетов, ни времени по часам. Всё, что
// нужно, чтобы повторить партию из seed и журнала команд.
export type Intent =
  // вход игрока в партию: id выдаётся сервером заранее, чтобы повтор совпал
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number }
  // выбор точки высадки; spawnRandom — когда игрок не выбрал за отведённое время
  | { t: 'spawn'; id: number; cell: number }
  | { t: 'spawnRandom'; id: number }
  | { t: 'respawn'; id: number; cell: number }
  // наземная атака и морской десант (ratio — доля армии)
  | { t: 'attack'; id: number; cell: number; ratio: number }
  | { t: 'invade'; id: number; cell: number; ratio: number }
  | { t: 'recall'; id: number; boatId: number }
  // постройки
  | { t: 'build'; id: number; bt: string; cell: number; levels?: number }
  | { t: 'upgrade'; id: number; cell: number; levels?: number }
  // оружие
  | { t: 'nuke'; id: number; cell: number; kind: string }
  | { t: 'drones'; id: number; cell: number }
  | { t: 'warship'; id: number; cell: number }
  | { t: 'warshipMove'; id: number; ids: number[]; cell: number }
  // дипломатия
  | { t: 'propose'; id: number; cell: number }
  | { t: 'allianceResponse'; id: number; from: number; accept: boolean }
  | { t: 'breakAlliance'; id: number; cell: number }
  | { t: 'war'; id: number; cell: number }
  | { t: 'donate'; id: number; cell: number; kind: 'gold' | 'troops'; amount: number };

/** Результат применения команды: текст ошибки для того, кто её отправил (или null). */
export interface IntentResult {
  id: number; // кому адресован ответ
  error: string | null;
}
