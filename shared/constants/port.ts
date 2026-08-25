import { dpow } from '../fixmath';
// Торговый порт и экономика трейда
// ЕДИНАЯ лестница цен порта: и постройка нового, и апгрейд существующего берут
// цену из одной таблицы по СУММЕ УРОВНЕЙ всех своих портов. Раньше апгрейд считался
// отдельно по уровню конкретного порта, поэтому второй порт и апгрейд первого стоили
// по-разному — теперь это один и тот же шаг «поднять суммарный уровень на 1».
//   сумма 0 → 200к     первый порт
//   сумма 1 → 250к     второй порт ИЛИ апгрейд единственного до 2 ур.
//   сумма 2 → 500к     третий шаг
//   сумма 3…29 → 1 млн
//   сумма 30+ → 1.5 млн
const PORT_COSTS = [200_000, 250_000, 500_000];
const PORT_COST_LATE = 1_000_000;
const PORT_COST_DEEP = 1_500_000;
const PORT_DEEP_FROM = 30; // с этой суммы уровней шаг дорожает до PORT_COST_DEEP
export const PORT_BUILD_COST = PORT_COSTS[0]; // цена первого порта
export function portCost(portLevels: number): number {
  const n = Math.max(0, portLevels);
  if (n < PORT_COSTS.length) return PORT_COSTS[n];
  return n >= PORT_DEEP_FROM ? PORT_COST_DEEP : PORT_COST_LATE;
}
export const PORT_BUILD_TICKS = 50; // 5с
// Темп выпуска судов из порта. Это НЕ «сколько судов у порта» — вместимость задаёт
// shipsForLevel(level), а интервал только определяет, как быстро порт её набирает.
// Было 70 тиков (7с): порт 5 уровня, начав торговать с нуля, выпускал первое судно
// сразу, а пятое только через 28 секунд, и на коротких маршрутах до вместимости не
// добирался вообще — фактическое число судов задавал темп, а не уровень.
export const PORT_SHIP_INTERVAL = 15; // судно раз в 1.5с, пока есть свободное место
export const TRADE_BASE_VALUE = 3000; // деньги за заход в порт (1 ур.)
export const PORT_RADIUS = 10; // клик в этом радиусе от порта — апгрейд, а не новый

export function tradeValue(level: number): number {
  // +5% за уровень, без потолка: «прайс доставки» растёт вечно, но от низкой базы
  return TRADE_BASE_VALUE * dpow(1.05, level - 1);
}
export function shipsForLevel(level: number): number {
  return Math.max(0, level); // +1 судно за каждый уровень, без потолка
}
