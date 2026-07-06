// Детерминированный цвет игрока по id (золотое сечение по кругу оттенков),
// чтобы клиент и сервер не пересылали цвета по сети.
export function playerColorRGB(id: number): [number, number, number] {
  const h = (id * 137.508) % 360;
  const s = 0.65;
  const l = 0.52;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function playerColorCSS(id: number): string {
  const [r, g, b] = playerColorRGB(id);
  return `rgb(${r},${g},${b})`;
}
