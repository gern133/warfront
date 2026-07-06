export const MAP_W = 400;
export const MAP_H = 400;
export const CELLS = MAP_W * MAP_H;
export const TICK_MS = 100;
export const PORT = 8080;
export const SPAWN_WAIT_S = 20; // время на выбор точки старта
export const MAX_HUMANS = 100; // лимит людей в комнате

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface PlayerPub {
  id: number;
  name: string;
  troops: number;
  maxTroops: number;
  cells: number;
  alive: boolean;
  bot: boolean;
  strong: boolean;
}

// Активная атака: сколько войск выделено против кого
export interface AttackPub {
  player: number;
  target: number; // 0 = нейтральная земля
  troops: number;
}

export type ClientMsg =
  | { type: 'quick'; name: string } // быстрая игра — общая публичная комната
  | { type: 'create'; name: string; difficulty: Difficulty }
  | { type: 'joinLobby'; name: string; code: string }
  | { type: 'start' } // хост запускает игру в лобби
  | { type: 'spawn'; cell: number } // выбор точки старта
  | { type: 'respawn' } // реванш после смерти в той же комнате
  | { type: 'attack'; cell: number; ratio: number };

export type ServerMsg =
  | {
      type: 'lobby';
      code: string;
      host: boolean;
      difficulty: Difficulty;
      players: string[];
    }
  | {
      type: 'init';
      selfId: number;
      code: string;
      terrain: number[];
      owners: number[];
      players: PlayerPub[];
      spawnSeconds?: number; // сколько осталось на выбор спавна (фаза spawn)
    }
  | { type: 'update'; changes: number[]; players: PlayerPub[]; attacks: AttackPub[] }
  | { type: 'spawned' }
  | { type: 'roundStart' } // все выбрали спавн или вышло время — игра пошла
  | { type: 'dead' }
  | { type: 'winner'; name: string }
  | { type: 'error'; message: string };
