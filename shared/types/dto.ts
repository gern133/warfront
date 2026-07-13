import { BuildingType } from './common';

// Публичные снимки сущностей, которые сервер шлёт клиенту

export interface PlayerPub {
  id: number;
  name: string;
  troops: number;
  maxTroops: number;
  cells: number;
  alive: boolean;
  bot: boolean;
  strong: boolean;
  money: number;
}

export interface BuildingPub {
  id: number;
  owner: number;
  cell: number;
  type: BuildingType;
  progress: number; // 0..1 — прогресс постройки (1 = достроено)
  level: number; // hq: 1..3; port/city: любой; silo: размер залпа
  fuse: number; // секунд до взрыва после захвата (0 = не тикает)
  upProgress: number; // 0..1 — прогресс апгрейда (0 = не улучшается)
  ammo: number; // silo: сколько ракет заряжено сейчас (иначе 0)
}

// Трейд-корабль (без следа — только кружок, для производительности)
export interface TradeShipPub {
  id: number;
  owner: number;
  x: number;
  y: number;
}

// Грузовик завода: едет по дорогам между зданиями (для отрисовки)
export interface TruckPub {
  x: number;
  y: number;
  owner: number;
}

// Боевой корабль: плывёт к зоне и патрулирует её, стреляя по вражеским судам
export interface WarshipPub {
  id: number;
  owner: number;
  x: number;
  y: number;
  hp: number; // 0..1 — доля здоровья (для полоски)
}

// Всплывающий заработок (для показа КПД игроку) — в точке, где корабль заработал
export interface TradeEarn {
  x: number; // позиция корабля в момент выплаты (чужой порт / свой при возврате)
  y: number;
  amount: number; // сколько денег принёс заход
  owner: number; // владелец корабля (клиент показывает только свои)
}

// Ракета в полёте: клиент рисует баллистическую дугу от (sx,sy) к (tx,ty),
// светящийся кружок в текущей точке (prog) и трассер за ним
export interface MissilePub {
  id: number;
  owner: number;
  kind: string; // ключ в NUKES
  sx: number; // старт (шахта), в клетках
  sy: number;
  tx: number; // цель
  ty: number;
  prog: number; // 0..1 — доля пути
  intercept: boolean; // true = ракета-перехватчик ПВО (другой цвет, без взрыва)
}

// Активная атака: сколько войск выделено против кого
export interface AttackPub {
  player: number;
  target: number; // 0 = нейтральная земля
  troops: number;
}

// Морской десант в пути: кружок плывёт по маршруту path (обходит сушу)
export interface BoatPub {
  id: number;
  player: number;
  target: number; // 0 = нейтральный берег
  troops: number;
  x: number; // текущая позиция (в клетках, с покачиванием)
  y: number;
  path: number[]; // маршрут: [x0,y0,x1,y1,...] в клетках (проредённый)
  prog: number; // 0..1 — доля пройденного пути (для следа)
}
