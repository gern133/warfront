// Форматирование числа войск для подписей на карте: метки атаки/обороны (⚔️/🛡),
// подписи стран и десантов. Раньше был только порог тысяч, поэтому миллионная армия
// выглядела как «1100.0k» — теперь это «1.1m».
export function fmtTroops(n: number): string {
  // Порог берётся с учётом округления до одного знака: иначе 999 999 показывалось бы
  // как «1000.0k» вместо «1.0m».
  if (n >= 999_500_000) return (n / 1_000_000_000).toFixed(1) + 'b';
  if (n >= 999_500) return (n / 1_000_000).toFixed(1) + 'm';
  if (n >= 999.5) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}

// компактный формат для HUD: 1234 → 1.2K, 1200000 → 1.2M, 1e9 → 1B
export function fmtK(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'K';
  return String(Math.floor(n));
}

// Время до события в компактном виде: «12с», «1:05». Для таймеров прибытия десанта.
export function fmtEta(sec: number): string {
  const t = Math.max(0, Math.ceil(sec));
  if (t < 60) return `${t}с`;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
