import { BuildingType } from '../../shared/protocol';

// Внутренние сущности серверной симуляции (не путать с *Pub из shared/types)

export interface Player {
  id: number;
  name: string;
  troops: number;
  maxTroops: number;
  cells: number;
  alive: boolean;
  spawned: boolean; // человек ещё не выбрал точку старта — false
  bot: boolean;
  strong: boolean;
  passive: boolean; // слабые боты-«корм»: только расширяются в нейтраль
  growthMul: number;
  maxMul: number; // множитель потолка войск (у корма втрое меньше)
  money: number;
  thinkAt: number;
  spawnTick: number; // когда игрок высадился (для раннего буста роста)
}

export interface Building {
  id: number;
  owner: number;
  cell: number;
  type: BuildingType;
  readyTick: number; // тик, на котором постройка завершится
  level: number; // 1 обычный, 2 взрыв по области, 3 усиленный
  fuseTick: number; // тик взрыва после захвата (0 = не тикает)
  upStart: number; // тик начала апгрейда (0 = не улучшается)
  upEnd: number; // тик завершения апгрейда
  nextShipTick: number; // порт: когда выпускать следующий корабль
  ships: number; // порт: кораблей в полёте
  stock: number; // шахта: заряженных ракет сейчас (0..level)
  reloadTick: number; // шахта: когда добавить +1 ракету в залп
  reloads: number[]; // ПВО: тики восстановления израсходованных зарядов (параллельно)
}

export interface TradeShip {
  id: number;
  owner: number;
  portCell: number; // домашний порт (для учёта кораблей)
  path: number[]; // маршрут по воде
  cum: number[];
  totalLen: number;
  traveled: number;
  returning: boolean; // возвращается домой
  payout: number; // деньги за заход (с учётом уровня и дистанции)
  done: boolean; // рейс завершён — на удаление
  x: number;
  y: number;
}

export interface Missile {
  id: number;
  owner: number;
  kind: string; // ключ в NUKES
  sx: number; // старт (шахта)
  sy: number;
  tx: number; // цель
  ty: number;
  targetCell: number;
  prog: number; // 0..1
  flightTicks: number; // полное время полёта (по расстоянию)
  done: boolean;
  intercept: boolean; // true = перехватчик ПВО (летит к ядерке, не взрывается)
  killProg: number; // для ядерки: prog, на котором её собьёт ПВО (0 = не перехвачена)
}

export interface Attack {
  player: number;
  target: number; // id владельца-цели, 0 = нейтральная земля
  troops: number;
  frontier: Set<number>; // волна захвата, поддерживается инкрементально
  rescanned: boolean; // полный пересбор фронта уже был после опустошения
}

export interface Boat {
  id: number;
  player: number;
  target: number; // владелец берега-цели на момент отправки
  troops: number;
  path: number[]; // маршрут по воде: [x0,y0,x1,y1,...] в клетках
  cum: number[]; // накопленная дистанция в каждой точке пути (cum[0]=0)
  totalLen: number; // полная длина маршрута
  traveled: number; // пройдено вдоль маршрута (0..totalLen)
  returning: boolean; // отозван — возвращается к старту
  landCell: number; // клетка берега для высадки
  x: number; // текущая позиция на маршруте
  y: number;
}

// Боевой корабль: идёт к зоне по маршруту path, затем патрулирует её по кругу,
// стреляя по вражеским (hostile) судам в радиусе
export interface Warship {
  id: number;
  owner: number;
  x: number; // текущая позиция (клетки)
  y: number;
  path: number[]; // маршрут к зоне патруля [x0,y0,...]
  cum: number[];
  totalLen: number;
  traveled: number;
  moving: boolean; // true — идёт к зоне; false — патрулирует
  patrolX: number; // центр зоны патруля
  patrolY: number;
  patrolAng: number; // текущий угол на орбите
  hp: number; // здоровье (0..WARSHIP_HP)
  cooldown: number; // тиков до следующего выстрела
  hits: number; // сколько пуль прилетело с прошлой полной починки (время ремонта)
  repairing: boolean; // идёт в порт чиниться / стоит на ремонте
  healTicks: number; // тиков ремонта осталось (0 = не чинится)
  healRate: number; // прибавка hp за тик во время ремонта
}

// Пуля боевого корабля: летит пикселем и догоняет цель, при попадании — урон
export interface Bullet {
  id: number;
  owner: number;
  fromId: number; // id выпустившего корабля (лимит активных пуль на корабль)
  x: number;
  y: number;
  targetId: number; // id цели
  targetKind: 'war' | 'trade' | 'boat'; // тип цели
  dmg: number;
}
