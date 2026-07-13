import { BuildingType, Difficulty, MapType } from './common';
import {
  AttackPub,
  BoatPub,
  BuildingPub,
  MissilePub,
  PlayerPub,
  TradeEarn,
  TradeShipPub,
  TruckPub,
  WarshipPub,
} from './dto';

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
  | { type: 'nuke'; cell: number; kind?: string } // пуск ракеты в точку (с ближайшей шахты)
  | { type: 'warship'; cell: number } // выпустить боевой корабль из ближайшего порта в зону
  | { type: 'warshipMove'; ids: number[]; cell: number } // приказ выделенным кораблям идти в точку
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
      trucks: TruckPub[]; // грузовики заводов на дорогах
      roads?: number[][]; // дороги (ломаные [x,y,...]) — шлём реже (меняются редко)
      warships: WarshipPub[]; // боевые корабли
      shots: number[]; // выстрелы кораблей за тик: [sx,sy,tx,ty,hit,...] (для трассеров)
      missiles: MissilePub[]; // ракеты в полёте
      earnings: TradeEarn[]; // заработок портов за интервал (для всплывашек)
      speed: number; // текущая скорость игры
      humans: number; // сколько реальных игроков в комнате
    }
  | { type: 'resync'; ownersRle: number[] } // полный снимок владельцев (после лага)
  | { type: 'relations'; allies: number[]; enemies: number[] } // отношения игрока
  | { type: 'proposal'; from: number; name: string } // входящее предложение союза
  | { type: 'notice'; kind: 'accept' | 'reject' | 'break'; name: string } // событие союза: принял/отклонил/расторг
  | { type: 'spawned' }
  | { type: 'roundStart' } // все выбрали спавн или вышло время — игра пошла
  | { type: 'dead' }
  | { type: 'winner'; name: string; id: number }
  | { type: 'error'; message: string };
