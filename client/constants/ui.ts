import { BuildingType, Difficulty, MapType } from '../../shared/protocol';

// Ботов всегда 300 (275 пассивного «корма» + 25 стран); сложность меняет силу
// стран относительно игрока
export const DIFF_LABELS: Record<Difficulty, { name: string; desc: string }> = {
  easy: { name: 'Лёгкий', desc: 'страны слабее вас' },
  normal: { name: 'Средний', desc: 'страны как вы' },
  hard: { name: 'Тяжёлый', desc: 'страны на 20% сильнее' },
  insane: { name: 'Безумный', desc: 'страны на 50% сильнее' },
};

export const MAP_LABELS: Record<MapType, { name: string; desc: string }> = {
  random: { name: 'Случайный мир', desc: 'новые континенты каждый раунд' },
  earth: { name: 'Земля', desc: 'реальные материки и острова' },
};

// панель зданий/вооружений (1–0)
export const TOOLS: { icon: string; bt: BuildingType | null; name: string }[] = [
  { icon: '🏙️', bt: 'city', name: 'Город' },
  { icon: '🏭', bt: null, name: 'Завод' },
  { icon: '⚓', bt: 'port', name: 'Торговый порт' },
  { icon: '🛡️', bt: 'hq', name: 'Штаб обороны' },
  { icon: '🚀', bt: 'silo', name: 'Ракетная шахта' },
  { icon: '📡', bt: null, name: 'Радар' },
  { icon: '🚢', bt: null, name: 'Флот' },
  { icon: '☢️', bt: null, name: 'Ядерка' },
  { icon: '💥', bt: null, name: 'Удар' },
  { icon: '💣', bt: null, name: 'Бомба' },
];
