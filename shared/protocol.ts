export const TICK_MS = 100;
export const PORT = 8080;
export const SPAWN_WAIT_S = 20; // время на выбор точки старта
export const MAX_HUMANS = 100; // лимит людей в комнате

export type Difficulty = 'easy' | 'normal' | 'hard' | 'insane';
export type MapType = 'random' | 'earth';

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

export const START_MONEY = 40000;

// Здания: штаб обороны, торговый порт, город.
export type BuildingType = 'hq' | 'port' | 'city';

export interface BuildingPub {
  id: number;
  owner: number;
  cell: number;
  type: BuildingType;
  progress: number; // 0..1 — прогресс постройки (1 = достроено)
  level: number; // hq: 1..3; port/city: любой
  fuse: number; // секунд до взрыва после захвата (0 = не тикает)
  upProgress: number; // 0..1 — прогресс апгрейда (0 = не улучшается)
}

// Город: даёт прибавку к лимиту войск; апгрейд мгновенный и бесконечный.
// Цена растёт «в общем» — от суммарного уровня ВСЕХ твоих городов (не по каждому
// зданию): первые покупки по нарастающей, дальше фиксированно 1млн. Каждая
// следующая покупка (постройка нового города ИЛИ апгрейд любого) берёт цену по
// текущей сумме уровней: 0→50к, 1→75к, 2→100к, 3→250к, 4→500к, 5+→1млн.
export const CITY_BUILD_TICKS = 50; // 5с на постройку
const CITY_COSTS = [50000, 75000, 100000, 250000, 500000, 1000000];
export function cityCost(ownedLevels: number): number {
  return CITY_COSTS[Math.min(Math.max(0, ownedLevels), CITY_COSTS.length - 1)];
}
// прибавка к максимуму войск от города данного уровня
export function cityTroopBonus(level: number): number {
  return 10000 * level;
}

// Торговый порт
export const PORT_BUILD_COST = 50000;
export const PORT_BUILD_TICKS = 50; // 5с
export const PORT_SHIP_INTERVAL = 70; // корабль раз в 7с (на 1 ур. — 1 корабль)
export const PORT_MAX_SHIP_LEVEL = 30; // после 30 ур. число кораблей не растёт
export const TRADE_BASE_VALUE = 20000; // деньги за заход в порт (1 ур.)
export const PORT_RADIUS = 10; // клик в этом радиусе от порта — апгрейд, а не новый

export function portUpgradeCost(toLevel: number): number {
  return 30000 * (toLevel - 1); // до 2 ур. — 30к, до 3 — 60к, ...
}
export function tradeValue(level: number): number {
  // +3% за уровень (и до 30, и после — так растёт «прайс доставки»)
  return TRADE_BASE_VALUE * Math.pow(1.03, level - 1);
}
export function shipsForLevel(level: number): number {
  return Math.min(level, PORT_MAX_SHIP_LEVEL);
}

// Трейд-корабль (без следа — только кружок, для производительности)
export interface TradeShipPub {
  id: number;
  owner: number;
  x: number;
  y: number;
}

// Всплывающий заработок (для показа КПД игроку) — в точке, где корабль заработал
export interface TradeEarn {
  x: number; // позиция корабля в момент выплаты (чужой порт / свой при возврате)
  y: number;
  amount: number; // сколько денег принёс заход
  owner: number; // владелец корабля (клиент показывает только свои)
}

// Отношения игрока (относительно себя): союзники и враги; остальные нейтральны
export type RelationState = 'neutral' | 'hostile' | 'allied';

// Время постройки штаба обороны (тики; 50 = 5 секунд при 100мс)
export const HQ_BUILD_TICKS = 50;
// Прокачанный штаб при захвате взрывается через 10с с уроном по области
export const HQ_FUSE_TICKS = 100;
export const HQ_EXPLODE_RADIUS = 12;
export const MAX_HQ_LEVEL = 3;

// Апгрейд: цена и время (тики) для перехода на уровень (2 или 3)
export function hqUpgradeCost(toLevel: number): number {
  return toLevel === 2 ? 60000 : 120000;
}
export function hqUpgradeTicks(toLevel: number): number {
  return toLevel === 2 ? 50 : 100; // 5с до 2 ур., 10с до 3 ур.
}

// Цена штаба обороны растёт с каждой постройкой; потолок — 150к
const HQ_COSTS = [40000, 75000, 100000, 125000, 150000];
export function hqCost(owned: number): number {
  return HQ_COSTS[Math.min(owned, HQ_COSTS.length - 1)];
}

// Радиус защиты штаба (клетки): в этой зоне атака на владельца идёт 5:1
export const HQ_RADIUS = 16;

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

export type ClientMsg =
  | { type: 'quick'; name: string } // быстрая игра — общая публичная комната
  | { type: 'create'; name: string; difficulty: Difficulty; map: MapType }
  | { type: 'joinLobby'; name: string; code: string }
  | { type: 'start' } // хост запускает игру в лобби
  | { type: 'spawn'; cell: number } // выбор точки старта
  | { type: 'respawn' } // реванш после смерти в той же комнате
  | { type: 'rematch' } // новый раунд после победы (свежая карта)
  | { type: 'leave' } // выход из комнаты в меню
  | { type: 'attack'; cell: number; ratio: number } // сухопутная атака (ЛКМ)
  | { type: 'invade'; cell: number; ratio: number } // морское вторжение (ПКМ)
  | { type: 'recall'; boatId: number } // отозвать десант
  | { type: 'build'; bt: BuildingType; cell: number } // построить здание
  | { type: 'upgrade'; cell: number } // прокачать здание
  | { type: 'setSpeed'; speed: number } // скорость игры (0 пауза,1,2,3,10)
  | { type: 'propose'; cell: number } // предложить союз владельцу клетки
  | { type: 'allianceResponse'; from: number; accept: boolean } // ответ на предложение
  | { type: 'breakAlliance'; cell: number }; // расторгнуть союз с владельцем клетки

export type ServerMsg =
  | {
      type: 'lobby';
      code: string;
      host: boolean;
      difficulty: Difficulty;
      map: MapType;
      players: string[];
    }
  | {
      type: 'init';
      selfId: number;
      code: string;
      w: number;
      h: number;
      terrainRle: number[]; // RLE: [значение, длина, ...]
      ownersRle: number[];
      players: PlayerPub[];
      spawnSeconds?: number; // сколько осталось на выбор спавна (фаза spawn)
    }
  | {
      type: 'update';
      changes: number[];
      players: PlayerPub[];
      attacks: AttackPub[];
      boats: BoatPub[];
      buildings: BuildingPub[];
      ships: TradeShipPub[]; // трейд-корабли (кружки без следа)
      earnings: TradeEarn[]; // заработок портов за интервал (для всплывашек)
      speed: number; // текущая скорость игры
      humans: number; // сколько реальных игроков в комнате
    }
  | { type: 'resync'; ownersRle: number[] } // полный снимок владельцев (после лага)
  | { type: 'relations'; allies: number[]; enemies: number[] } // отношения игрока
  | { type: 'proposal'; from: number; name: string } // входящее предложение союза
  | { type: 'spawned' }
  | { type: 'roundStart' } // все выбрали спавн или вышло время — игра пошла
  | { type: 'dead' }
  | { type: 'winner'; name: string; id: number }
  | { type: 'error'; message: string };
