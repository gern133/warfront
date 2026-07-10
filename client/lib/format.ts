// Форматирование чисел для подписей на карте
export function fmtTroops(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

export function fmtMoney(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}

// компактный формат для HUD: 1234 → 1.2K, 1200000 → 1.2M
export function fmtK(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'K';
  return String(Math.floor(n));
}
