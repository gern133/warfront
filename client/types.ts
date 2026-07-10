import { Difficulty, MapType } from '../shared/protocol';

// Фазы клиента и вспомогательные UI-типы
export type Phase = 'menu' | 'lobby' | 'spawn' | 'playing' | 'dead';
export type MenuView = 'main' | 'create' | 'join';

export interface LobbyInfo {
  code: string;
  host: boolean;
  difficulty: Difficulty;
  map: MapType;
  players: string[];
}
