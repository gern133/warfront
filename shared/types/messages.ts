import type { Intent } from './intent';
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
  | { type: 'lobbySettings'; infMoney: boolean; infArmy: boolean } // хост меняет настройки карты
  | { type: 'war'; cell: number } // объявить войну владельцу клетки (нейтралу)
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
  | { type: 'drones'; cell: number } // запустить рой дронов «Мопед» по стране-владельцу клетки
  | { type: 'warshipMove'; ids: number[]; cell: number } // приказ выделенным кораблям идти в точку
  // клиент считает симуляцию сам — состояние мира ему присылать не нужно
  | { type: 'localSim'; on: boolean }
  // Локальной симуляции нужно состояние: клиент подключился к уже идущей партии
  // (с нулевого хода её не догнать) либо разошёлся с сервером по хешу.
  | { type: 'simResync' }
  | { type: 'setSpeed'; speed: number } // скорость игры (0 пауза,1,2,3,10)
  | { type: 'propose'; cell: number } // предложить союз владельцу клетки
  | { type: 'allianceResponse'; from: number; accept: boolean } // ответ на предложение
  | { type: 'breakAlliance'; cell: number } // расторгнуть союз с владельцем клетки
  | { type: 'donate'; cell: number; kind: 'gold' | 'troops'; amount: number }; // подарок союзнику

export type ServerMsg =
  | {
      type: 'lobby';
      code: string;
      host: boolean;
      difficulty: Difficulty;
      map: MapType;
      players: string[];
      settings: { infMoney: boolean; infArmy: boolean };
    }
  | {
      type: 'init';
      selfId: number;
      code: string;
      w: number;
      h: number;
      mapType: string; // тип карты: клиентской симуляции нужен тот же
      seed: number; // сид симуляции: по нему партия воспроизводится побитово
      difficulty?: string; // сложность: клиентской симуляции нужно поднять тех же ботов
      tickNo?: number; // текущий ход на сервере
      terrainRle: number[]; // RLE: [значение, длина, ...]
      ownersRle: number[];
      // Игроки: динамика — плоский массив по 6 чисел [id, войска, потолок, клетки, деньги,
      // жив?]; статика (имя, флаги) приходит в playersMeta и только при изменении набора.
      players?: number[];
      playersMeta?: { id: number; name: string; bot: boolean; strong: boolean }[] | null;
      spawnSeconds?: number; // сколько осталось на выбор спавна (фаза spawn)
    }
  | {
      type: 'update';
      // Дельты клеток RLE-сериями: [Δначало, длина, владелец, ...]; Δначало —
      // разность от начала предыдущей серии (см. applyUpdate на клиенте)
      changes?: number[]; // необязательно: клиенту с локальной симуляцией состояние не нужно
      // Поток ходов: команды хода и хеш состояния после него. В модели lockstep
      // этого достаточно, чтобы клиент считал симуляцию сам (см. docs/determinism.md)
      turn?: Intent[];
      turnNo?: number;
      hash?: number;
      // Игроки: динамика — плоский массив по 6 чисел [id, войска, потолок, клетки,
      // деньги, жив?]; статика (имя, флаги) — в playersMeta и только при изменении набора
      players?: number[];
      playersMeta?: { id: number; name: string; bot: boolean; strong: boolean }[] | null;
      attacks?: AttackPub[];
      boats?: BoatPub[];
      // Здания — плоский массив целых по 10 чисел на здание: [id, владелец, клетка,
      // тип (индекс в BUILDING_TYPES), уровень, заряд, прогресс·100, апгрейд·100,
      // фитиль·10, очередь апгрейдов]. Приходит ДЕЛЬТОЙ: только изменившиеся записи.
      buildings?: number[];
      buildingsGone?: number[]; // id исчезнувших зданий
      buildingsFull?: boolean; // это полная посылка, а не дельта (сброс кэша клиента)
      // Трейд-суда — плоский массив целых по 3 числа на судно: [x·10, y·10, владелец]
      ships?: number[];
      trucks?: TruckPub[]; // грузовики заводов на дорогах
      roads?: number[][]; // дороги (ломаные [x,y,...]) — шлём реже (меняются редко)
      warships?: WarshipPub[]; // боевые корабли
      // Дроны — плоский массив целых по 4 числа на дрон: [x·10, y·10, курс·100, владелец].
      // Так на рой в сотни дронов уходит в разы меньше трафика, чем массивом объектов.
      drones?: number[];
      droneBlasts?: number[]; // взрывы дронов за тик: [x,y,...] (для вспышек)
      shots?: number[]; // выстрелы кораблей за тик: [sx,sy,tx,ty,hit,...] (для трассеров)
      missiles?: MissilePub[]; // ракеты в полёте
      earnings?: TradeEarn[]; // заработок портов за интервал (для всплывашек)
      speed: number; // текущая скорость игры
      humans: number; // сколько реальных игроков в комнате
    }
  | { type: 'resync'; ownersRle: number[] } // полный снимок владельцев (после лага)
  // Снимок симуляции для клиента, который считает её сам (см. GameSnapshot).
  // Едет отдельным сжатым бинарным кадром — он большой (несколько МБ текста),
  // поэтому в этом сообщении только заголовок, а `snap` разбирает воркер.
  | { type: 'simSnapshot'; turnNo: number; snap: unknown }
  | { type: 'relations'; allies: number[]; enemies: number[] } // отношения игрока
  | { type: 'proposal'; from: number; name: string } // входящее предложение союза
  // союз: принял/отклонил/расторг; trade: уничтожил мой торговый корабль;
  // attacked: у меня начали отбирать территорию (x,y — место, куда фокусировать);
  // drones: на меня летит рой дронов (координат нет — клиент сам ищет ближайший дрон)
  | {
      type: 'notice';
      kind: 'accept' | 'reject' | 'break' | 'trade' | 'attacked' | 'drones';
      name: string;
      x?: number;
      y?: number;
    }
  | { type: 'spawned' }
  | { type: 'roundStart' } // все выбрали спавн или вышло время — игра пошла
  | { type: 'dead' }
  | { type: 'winner'; name: string; id: number }
  | { type: 'error'; message: string };
