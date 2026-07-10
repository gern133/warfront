// Цвета и пороги рендеринга карты (RGB-триплеты)
export const FORT_BORDER: [number, number, number] = [222, 214, 196]; // каменная граница
export const WATER: [number, number, number] = [58, 96, 140];
export const WAR: [number, number, number] = [225, 36, 26]; // линия фронта

// метки стран/людей показываем, когда приблизились вдвое от обзорного зума;
// «корм» — только если он огромный или приближение очень сильное
export const LABEL_ZOOM_MUL = 2;
export const FOOD_LABEL_MUL = 5;
export const FOOD_LABEL_CELLS = 4000;

// цвета нейтральной местности по типу почвы — как на классических картах мира
export const TERRAIN: Record<number, [number, number, number]> = {
  1: [168, 190, 138], // трава
  2: [216, 203, 160], // песок
  3: [188, 183, 173], // камень
  4: [242, 244, 242], // снег
};
