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

// панель зданий/вооружений (1–0). bt — тип постройки, nuke — тип запускаемой ракеты
export const TOOLS: { icon: string; bt: BuildingType | null; name: string; nuke?: string; fleet?: boolean }[] = [
  { icon: '🏙️', bt: 'city', name: 'Город' },
  { icon: '🏭', bt: 'factory', name: 'Завод' },
  { icon: '⚓', bt: 'port', name: 'Торговый порт' },
  { icon: '🛡️', bt: 'hq', name: 'Штаб обороны' },
  { icon: '🚀', bt: 'silo', name: 'Ракетная шахта' },
  { icon: '🛰️', bt: 'sam', name: 'ПВО' },
  { icon: '🚢', bt: null, name: 'Боевой флот', fleet: true },
  { icon: '☢️', bt: null, name: 'Ядерка', nuke: 'basic' },
  { icon: '💥', bt: null, name: 'Водородная бомба', nuke: 'hydro' },
  { icon: '💣', bt: null, name: 'Бомба' },
];
