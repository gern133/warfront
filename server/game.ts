import { MAP_W, MAP_H, CELLS, PlayerPub, AttackPub, Difficulty } from '../shared/protocol';

export interface Player {
  id: number;
  name: string;
  troops: number;
  maxTroops: number;
  cells: number;
  alive: boolean;
  spawned: boolean; // человек ещё не выбрал точку старта — false
  bot: boolean;
  strong: boolean;
  growthMul: number;
  thinkAt: number;
}

interface Attack {
  player: number;
  target: number; // id владельца-цели, 0 = нейтральная земля
  troops: number;
  frontier: Set<number>; // волна захвата, поддерживается инкрементально
  rescanned: boolean; // полный пересбор фронта уже был после опустошения
}

const LAND_RATIO = 0.5;
const SPAWN_TROOPS = 600;
const NEUTRAL_COST = 1.4;
// Прирост в % от текущих войск за тик: у 100 юнитов и у 1500 — одинаковый процент
const GROWTH_RATE = 0.006;
// Доля фронта, захватываемая за тик — задаёт «постепенность» движения границы
const WAVE_SPEED = 0.15;

export const DIFFICULTY: Record<
  Difficulty,
  { weak: number; strong: number; strongMul: number }
> = {
  easy: { weak: 45, strong: 5, strongMul: 1.15 },
  normal: { weak: 55, strong: 15, strongMul: 1.4 },
  hard: { weak: 50, strong: 40, strongMul: 1.7 },
};

// Слабые боты: случайные имена из сочетаний
const NAME_ADJ = [
  'Дикие', 'Лесные', 'Степные', 'Горные', 'Северные', 'Южные', 'Багровые',
  'Чёрные', 'Золотые', 'Серые', 'Огненные', 'Ледяные', 'Тёмные', 'Вольные', 'Древние',
];
const NAME_NOUN = [
  'Волки', 'Вороны', 'Медведи', 'Змеи', 'Ястребы', 'Кабаны', 'Лисы', 'Быки',
  'Драконы', 'Шакалы', 'Тигры', 'Барсы', 'Грифы', 'Псы', 'Рыси',
];

const STRONG_NAMES = [
  '🇺🇸 США', '🇨🇳 Китай', '🇷🇺 Россия', '🇩🇪 Германия', '🇬🇧 Британия',
  '🇫🇷 Франция', '🇯🇵 Япония', '🇹🇷 Турция', '🇮🇳 Индия', '🇧🇷 Бразилия',
  '🇨🇦 Канада', '🇦🇺 Австралия', '🇪🇸 Испания', '🇮🇹 Италия', '🇲🇽 Мексика',
  '🇰🇷 Корея', '🇮🇩 Индонезия', '🇸🇦 Аравия', '🇦🇷 Аргентина', '🇵🇱 Польша',
  '🇳🇱 Нидерланды', '🇸🇪 Швеция', '🇨🇭 Швейцария', '🇳🇴 Норвегия', '🇺🇦 Украина',
  '🇪🇬 Египет', '🇿🇦 ЮАР', '🇳🇬 Нигерия', '🇵🇰 Пакистан', '🇻🇳 Вьетнам',
  '🇹🇭 Таиланд', '🇬🇷 Греция', '🇵🇹 Португалия', '🇨🇿 Чехия', '🇭🇺 Венгрия',
  '🇫🇮 Финляндия', '🇩🇰 Дания', '🇮🇪 Ирландия', '🇮🇱 Израиль', '🇰🇿 Казахстан',
];

function pickShuffled(names: string[], n: number): string[] {
  const pool = [...names];
  const out: string[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  }
  return out;
}

function weakNames(n: number): string[] {
  const combos: string[] = [];
  for (const a of NAME_ADJ) for (const b of NAME_NOUN) combos.push(`${a} ${b}`);
  return pickShuffled(combos, n);
}

export class Game {
  terrain = new Uint8Array(CELLS); // 1 = суша, 0 = вода
  owners = new Int16Array(CELLS); // 0 = нейтрально, иначе id игрока
  players = new Map<number, Player>();
  attacks: Attack[] = [];
  changed = new Map<number, number>(); // cell -> новый владелец, копится за тик
  deaths: number[] = [];
  tickNo = 0;
  landCount = 0;
  winnerId: number | null = null;
  private nextId = 1;

  constructor() {
    this.genTerrain();
  }

  reset() {
    this.terrain.fill(0);
    this.owners.fill(0);
    this.players.clear();
    this.attacks = [];
    this.changed.clear();
    this.deaths = [];
    this.winnerId = null;
    this.genTerrain();
  }

  addBots(difficulty: Difficulty) {
    const cfg = DIFFICULTY[difficulty];
    for (const name of weakNames(cfg.weak)) {
      this.addPlayer(name, { bot: true, growthMul: 0.8 });
    }
    for (const name of pickShuffled(STRONG_NAMES, cfg.strong)) {
      this.addPlayer(name, { bot: true, strong: true, growthMul: cfg.strongMul });
    }
  }

  // Органичные континенты: случайные зёрна + рост фронтира (модель Эдена)
  private genTerrain() {
    this.landCount = 0;
    const target = CELLS * LAND_RATIO;
    const frontier: number[] = [];
    const margin = 0.1;
    for (let s = 0; s < 14; s++) {
      const x = Math.floor(MAP_W * (margin + Math.random() * (1 - 2 * margin)));
      const y = Math.floor(MAP_H * (margin + Math.random() * (1 - 2 * margin)));
      const c = y * MAP_W + x;
      if (!this.terrain[c]) {
        this.terrain[c] = 1;
        this.landCount++;
        frontier.push(c);
      }
    }
    while (this.landCount < target && frontier.length) {
      const idx = (Math.random() * frontier.length) | 0;
      const c = frontier[idx];
      const free: number[] = [];
      this.forNeighbors(c, (n) => {
        if (!this.terrain[n]) free.push(n);
      });
      if (!free.length) {
        frontier[idx] = frontier[frontier.length - 1];
        frontier.pop();
        continue;
      }
      const n = free[(Math.random() * free.length) | 0];
      this.terrain[n] = 1;
      this.landCount++;
      frontier.push(n);
    }
  }

  private forNeighbors(c: number, fn: (n: number) => void) {
    const x = c % MAP_W;
    if (x > 0) fn(c - 1);
    if (x < MAP_W - 1) fn(c + 1);
    if (c >= MAP_W) fn(c - MAP_W);
    if (c < CELLS - MAP_W) fn(c + MAP_W);
  }

  addPlayer(
    name: string,
    opts: { bot?: boolean; strong?: boolean; growthMul?: number } = {}
  ): Player {
    const p: Player = {
      id: this.nextId++,
      name,
      troops: SPAWN_TROOPS,
      maxTroops: SPAWN_TROOPS,
      cells: 0,
      alive: true,
      spawned: false,
      bot: opts.bot ?? false,
      strong: opts.strong ?? false,
      growthMul: opts.growthMul ?? 1,
      thinkAt: this.tickNo + 20 + ((Math.random() * 30) | 0),
    };
    this.players.set(p.id, p);
    if (p.bot) this.spawnRandom(p); // люди выбирают точку старта сами
    return p;
  }

  // Игрок кликнул точку старта. true = успех
  trySpawn(playerId: number, cell: number): boolean {
    const p = this.players.get(playerId);
    if (!p?.alive || p.spawned) return false;
    if (cell < 0 || cell >= CELLS || !this.terrain[cell] || this.owners[cell] !== 0) {
      return false;
    }
    const cx = cell % MAP_W;
    const cy = (cell / MAP_W) | 0;
    // не слишком близко к чужим владениям
    const clearance = 5;
    for (let dy = -clearance; dy <= clearance; dy++) {
      for (let dx = -clearance; dx <= clearance; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        if (this.owners[y * MAP_W + x] !== 0) return false;
      }
    }
    this.claimDisk(cx, cy, p.id);
    p.spawned = true;
    p.troops = SPAWN_TROOPS;
    return true;
  }

  // Случайный спавн: для ботов и для людей, не успевших выбрать за таймер
  spawnRandom(p: Player) {
    for (let attempt = 0; attempt < 3000; attempt++) {
      const c = (Math.random() * CELLS) | 0;
      if (!this.terrain[c] || this.owners[c] !== 0) continue;
      const cx = c % MAP_W;
      const cy = (c / MAP_W) | 0;
      const clearance = attempt < 1500 ? 7 : 4;
      let ok = true;
      for (let dy = -clearance; dy <= clearance && ok; dy++) {
        for (let dx = -clearance; dx <= clearance && ok; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
          if (this.owners[y * MAP_W + x] !== 0) ok = false;
        }
      }
      if (!ok) continue;
      this.claimDisk(cx, cy, p.id);
      p.spawned = true;
      return;
    }
  }

  private claimDisk(cx: number, cy: number, id: number) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy > 9) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        const n = y * MAP_W + x;
        if (this.terrain[n] && this.owners[n] === 0) this.setOwner(n, id);
      }
    }
  }

  removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    for (let c = 0; c < CELLS; c++) {
      if (this.owners[c] === id) this.setOwner(c, 0);
    }
    this.attacks = this.attacks.filter((a) => a.player !== id);
    this.players.delete(id);
  }

  private setOwner(c: number, owner: number) {
    const prev = this.owners[c];
    if (prev === owner) return;
    if (prev > 0) {
      const p = this.players.get(prev);
      if (p) {
        p.cells--;
        if (p.cells <= 0 && p.alive && p.spawned) this.kill(p);
      }
    }
    if (owner > 0) {
      const p = this.players.get(owner);
      if (p) p.cells++;
    }
    this.owners[c] = owner;
    this.changed.set(c, owner);
  }

  private kill(p: Player) {
    p.alive = false;
    p.troops = 0;
    this.deaths.push(p.id);
    this.attacks = this.attacks.filter((a) => a.player !== p.id);
  }

  launchAttackCell(playerId: number, cell: number, ratio: number) {
    if (cell < 0 || cell >= CELLS || !this.terrain[cell]) return;
    const targetOwner = this.owners[cell];
    if (targetOwner === playerId) return;
    const p = this.players.get(playerId);
    if (!p?.alive || !p.spawned) return;
    const r = Math.min(1, Math.max(0.05, ratio || 0));
    this.launchAttackOwner(playerId, targetOwner, Math.floor(p.troops * r));
  }

  launchAttackOwner(playerId: number, targetOwner: number, troops: number) {
    const p = this.players.get(playerId);
    if (!p?.alive) return;
    troops = Math.min(troops, Math.floor(p.troops));
    if (troops < 10) return;
    p.troops -= troops;
    const existing = this.attacks.find((a) => a.player === playerId && a.target === targetOwner);
    if (existing) existing.troops += troops;
    else {
      this.attacks.push({
        player: playerId,
        target: targetOwner,
        troops,
        frontier: new Set(),
        rescanned: false,
      });
    }
  }

  tick() {
    this.tickNo++;
    for (const p of this.players.values()) {
      if (!p.alive || !p.spawned) continue;
      p.maxTroops = 150 + p.cells * 12;
      // процентный прирост: чем больше армия, тем больше абсолютный прирост
      const growth = Math.max(0.5, p.troops * GROWTH_RATE * p.growthMul);
      p.troops = Math.min(p.maxTroops, p.troops + growth);
      if (p.bot && this.tickNo >= p.thinkAt) this.botThink(p);
    }
    this.cancelOpposing();
    for (const a of this.attacks) this.stepAttack(a);
    this.attacks = this.attacks.filter(
      (a) => a.troops >= 1 && this.players.get(a.player)?.alive
    );
    if (this.winnerId === null) {
      for (const p of this.players.values()) {
        if (p.alive && p.cells > this.landCount * 0.65) {
          this.winnerId = p.id;
          break;
        }
      }
    }
  }

  // Встречные атаки взаимно уничтожаются 1:1 — граница движется в сторону того,
  // кто выделил больше войск, вместо пиксельной каши с двух сторон
  private cancelOpposing() {
    for (const a of this.attacks) {
      if (a.target <= 0 || a.troops < 1) continue;
      const b = this.attacks.find(
        (x) => x.player === a.target && x.target === a.player && x.troops >= 1
      );
      if (!b) continue;
      const m = Math.min(a.troops, b.troops);
      a.troops -= m;
      b.troops -= m;
    }
  }

  private refund(a: Attack, attacker: Player) {
    attacker.troops = Math.min(attacker.maxTroops, attacker.troops + a.troops);
    a.troops = 0;
  }

  private buildFrontier(a: Attack) {
    a.frontier.clear();
    for (let c = 0; c < CELLS; c++) {
      if (this.owners[c] !== a.target || !this.terrain[c]) continue;
      let adj = false;
      this.forNeighbors(c, (n) => {
        if (this.owners[n] === a.player) adj = true;
      });
      if (adj) a.frontier.add(c);
    }
  }

  // Волновой захват: фронт поддерживается инкрементально, клетки с большим
  // числом своих соседей берутся первыми — дыры зарастают, граница ровная
  private stepAttack(a: Attack) {
    const attacker = this.players.get(a.player);
    if (!attacker?.alive) {
      a.troops = 0;
      return;
    }
    const enemy = a.target > 0 ? this.players.get(a.target) : undefined;
    if (a.target > 0 && !enemy?.alive) {
      this.refund(a, attacker); // цель уничтожена — вернуть остаток
      return;
    }
    if (a.frontier.size === 0) {
      if (a.rescanned) {
        this.refund(a, attacker); // контакта с целью больше нет
        return;
      }
      this.buildFrontier(a);
      a.rescanned = true;
      if (a.frontier.size === 0) {
        this.refund(a, attacker);
        return;
      }
    }
    // корзины по числу своих соседей: сначала 4 (дыры), потом 3, 2, 1
    const buckets: number[][] = [[], [], [], [], []];
    for (const c of a.frontier) {
      if (this.owners[c] !== a.target) {
        a.frontier.delete(c); // клетку уже кто-то занял
        continue;
      }
      let own = 0;
      this.forNeighbors(c, (n) => {
        if (this.owners[n] === a.player) own++;
      });
      if (own === 0) {
        a.frontier.delete(c); // потеряли контакт с этой клеткой
        continue;
      }
      buckets[own].push(c);
    }
    if (a.frontier.size === 0) return; // пересоберём фронт на следующем тике
    a.rescanned = false;

    let cost = NEUTRAL_COST;
    if (enemy) {
      const density = enemy.cells > 0 ? enemy.troops / enemy.cells : 0;
      cost = 2.5 + density * 0.5;
    }
    let quota = Math.max(1, Math.ceil(a.frontier.size * WAVE_SPEED));
    for (let own = 4; own >= 1 && quota > 0; own--) {
      const list = buckets[own];
      while (list.length && quota > 0 && a.troops >= cost) {
        const i = (Math.random() * list.length) | 0;
        const c = list[i];
        list[i] = list[list.length - 1];
        list.pop();
        a.frontier.delete(c);
        this.setOwner(c, a.player);
        a.troops -= cost;
        if (enemy) enemy.troops = Math.max(0, enemy.troops - cost * 0.35);
        quota--;
        // расширяем фронт на соседей захваченной клетки
        this.forNeighbors(c, (n) => {
          if (this.terrain[n] && this.owners[n] === a.target) a.frontier.add(n);
        });
      }
    }
  }

  private botThink(p: Player) {
    // сильные боты думают чаще и бросают в атаку больше войск
    p.thinkAt = this.tickNo + (p.strong ? 18 : 25) + ((Math.random() * (p.strong ? 30 : 50)) | 0);
    const readiness = p.strong ? 0.25 : 0.4;
    if (p.troops < p.maxTroops * readiness || p.troops < 150) return;
    const counts = new Map<number, number>();
    for (let c = 0; c < CELLS; c++) {
      if (this.owners[c] !== p.id) continue;
      this.forNeighbors(c, (n) => {
        if (this.terrain[n] && this.owners[n] !== p.id) {
          const o = this.owners[n];
          counts.set(o, (counts.get(o) || 0) + 1);
        }
      });
    }
    if (!counts.size) return;
    let target: number;
    if (counts.has(0) && Math.random() < 0.75) {
      target = 0;
    } else {
      const enemies = [...counts.keys()].filter((k) => k !== 0);
      target = enemies.length ? enemies[(Math.random() * enemies.length) | 0] : 0;
    }
    this.launchAttackOwner(p.id, target, Math.floor(p.troops * (p.strong ? 0.5 : 0.35)));
  }

  playersPub(): PlayerPub[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      troops: Math.floor(p.troops),
      maxTroops: p.maxTroops,
      cells: p.cells,
      alive: p.alive,
      bot: p.bot,
      strong: p.strong,
    }));
  }

  attacksPub(): AttackPub[] {
    return this.attacks
      .filter((a) => a.troops >= 1)
      .map((a) => ({ player: a.player, target: a.target, troops: Math.floor(a.troops) }));
  }
}
