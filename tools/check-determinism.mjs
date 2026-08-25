// Проверка того, что симуляция осталась воспроизводимой.
//
// Запуск: npm run check:sim
//
// Две вещи, которые ломаются незаметно и проявляются как рассинхронизация у игроков
// (то есть в самый неудобный момент и без внятного стека):
//
//   1. В симуляции появилась функция, которую движки считают по-разному
//      (Math.pow/sin/cos/atan2/hypot/exp/log, оператор `**`) или Math.random.
//      Замена — shared/fixmath.ts.
//   2. Симуляция перестала быть воспроизводимой: два экземпляра с одним сидом и одним
//      потоком команд разошлись. Отдельно проверяем восстановление из снимка —
//      снимок обязан быть ПОЛНЫМ состоянием (см. docs/determinism.md).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// Файлы симуляции: их код исполняется и на сервере, и в браузерном воркере.
const SIM_FILES = ['server/game/index.ts', 'server/game/constants.ts', 'shared/fixmath.ts', 'shared/rng.ts', 'shared/rle.ts'];
for (const d of ['shared/constants', 'shared/map']) {
  for (const f of readdirSync(join(ROOT, d))) {
    if (f.endsWith('.ts')) SIM_FILES.push(`${d}/${f}`);
  }
}
// Генерация карты — исключение: она выполняется ТОЛЬКО на сервере, клиент получает
// готовую карту в init и сам её никогда не строит.
const SERVER_ONLY = new Set(['shared/map/mapmath.ts']);

const BANNED = /Math\.(pow|sin|cos|tan|atan2|atan|asin|acos|exp|log|log2|log10|cbrt|sinh|cosh|tanh|hypot|random)\s*\(|[^*]\*\*[^*=]/;
let problems = 0;
for (const rel of SIM_FILES) {
  if (SERVER_ONLY.has(rel)) continue;
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  // Комментарии вычищаем, сохраняя переводы строк: иначе `/**` попадёт под запрет
  // оператора `**`, а номера строк перестанут совпадать с файлом.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  src.split('\n').forEach((line, i) => {
    const code = line;
    if (!BANNED.test(code)) return;
    // сид новой партии берётся из Math.random один раз и уезжает клиентам — это не счёт
    if (code.includes('seed =') && code.includes('Math.random')) return;
    console.log(`✗ ${rel}:${i + 1}: ${raw.split('\n')[i].trim()}`);
    problems++;
  });
}
console.log(problems === 0 ? '✓ приближённых функций в симуляции нет' : `✗ найдено ${problems} мест`);

const { Game, setEarthTerrainProvider } = await import(join(ROOT, 'server/game/index.ts'));
const { earthTerrain } = await import(join(ROOT, 'server/map/earthmap.ts'));
setEarthTerrainProvider(earthTerrain);

const TICKS = Number(process.env.TICKS || 400);
const srv = new Game('earth', 20250824);
srv.addBots('normal');
for (const p of srv.players.values()) if (!p.spawned) srv.enqueue({ t: 'spawnRandom', id: p.id });
// второй экземпляр идёт по потоку команд — как это делает клиент
const cli = new Game('earth', 20250824, srv.terrain);
cli.addBots('normal');
let bad = -1;
for (let t = 0; t < TICKS; t++) {
  const n = srv.tickNo;
  srv.tick();
  for (const i of srv.turnLog[n] ?? []) cli.enqueue(i);
  cli.tick();
  if (bad < 0 && srv.stateHash() !== cli.stateHash()) bad = n;
}
if (bad < 0) console.log(`✓ ${TICKS} ходов по потоку команд: хеши совпадают`);
else { console.log(`✗ расхождение с потоком команд на ходу ${bad}`); problems++; }

// снимок: поднимаем третий экземпляр из состояния и продолжаем вместе
const snap = new Game('earth', 20250824, srv.terrain);
snap.restore(JSON.parse(JSON.stringify(srv.snapshot())));
let bad2 = srv.stateHash() === snap.stateHash() ? -1 : srv.tickNo;
for (let t = 0; t < TICKS && bad2 < 0; t++) {
  const n = srv.tickNo;
  srv.tick();
  for (const i of srv.turnLog[n] ?? []) snap.enqueue(i);
  snap.tick();
  if (srv.stateHash() !== snap.stateHash()) bad2 = n;
}
if (bad2 < 0) console.log(`✓ восстановление из снимка + ${TICKS} ходов: хеши совпадают`);
else { console.log(`✗ снимок неполный: расхождение на ходу ${bad2}`); problems++; }

process.exit(problems === 0 ? 0 : 1);
