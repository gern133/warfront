// Базовые перечисления, общие для клиента и сервера
export type Difficulty = 'easy' | 'normal' | 'hard' | 'insane';
export type MapType = 'random' | 'earth';

// Здания: штаб обороны, торговый порт, город, ракетная шахта
export type BuildingType = 'hq' | 'port' | 'city' | 'silo';

// Отношения игрока (относительно себя): союзники и враги; остальные нейтральны
export type RelationState = 'neutral' | 'hostile' | 'allied';
