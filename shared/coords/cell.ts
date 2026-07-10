// Преобразования между линейным индексом клетки и (x, y) на сетке ширины w.
// Клетки нумеруются по строкам: cell = y * w + x.
export function cellX(cell: number, w: number): number {
  return cell % w;
}
export function cellY(cell: number, w: number): number {
  return (cell / w) | 0;
}
export function toCell(x: number, y: number, w: number): number {
  return y * w + x;
}
// Квадрат расстояния между клетками (без корня — для сравнений/радиусов)
export function cellDist2(a: number, b: number, w: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}
