import { useEffect, useRef, useState } from 'react';
import {
  PlayerPub,
  AttackPub,
  BoatPub,
  BuildingPub,
  BuildingType,
  ServerMsg,
  PORT,
  Difficulty,
  MapType,
  hqCost,
  hqUpgradeCost,
  MAX_HQ_LEVEL,
  portUpgradeCost,
  shipsForLevel,
  PORT_BUILD_COST,
  cityCost,
  cityTroopBonus,
  SILO_COST,
  NUKES,
  samCost,
  factoryCost,
} from '../shared/protocol';
import { playerColorCSS } from '../shared/color';
import { GameClient } from './engine/GameClient';
import { Phase, MenuView, LobbyInfo } from './types';
import { TOOLS } from './constants/ui';
import { fmtK } from './lib/format';
import { MenuScreen } from './screens/MenuScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { DeadScreen, WinnerModal } from './screens/EndScreens';

export default function App() {
  const [phase, setPhase] = useState<Phase>('menu');
  const [menuView, setMenuView] = useState<MenuView>('main');
  const [name, setName] = useState(() => localStorage.getItem('wf-name') || '');
  const [joinCode, setJoinCode] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [mapType, setMapType] = useState<MapType>('random');
  const [lobby, setLobby] = useState<LobbyInfo | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [players, setPlayers] = useState<PlayerPub[]>([]);
  const [attacks, setAttacks] = useState<AttackPub[]>([]);
  const [boats, setBoats] = useState<BoatPub[]>([]);
  const [buildings, setBuildings] = useState<BuildingPub[]>([]);
  const [buildMode, setBuildMode] = useState<BuildingType | null>(null);
  const [nukeKind, setNukeKind] = useState<string | null>(null); // выбранная ракета для наведения
  const [fleetMode, setFleetMode] = useState(false); // выбран инструмент «Боевой флот»
  const [shownMoney, setShownMoney] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [humans, setHumans] = useState(1);
  const [spawnLeft, setSpawnLeft] = useState<number | null>(null);
  const [winner, setWinner] = useState<{ name: string; you: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ratio, setRatio] = useState(15);
  const [connected, setConnected] = useState(false);
  const [invadeMenu, setInvadeMenu] = useState<{ cell: number; x: number; y: number } | null>(null);
  const [upgradeMenu, setUpgradeMenu] = useState<
    { cell: number; x: number; y: number; level: number } | null
  >(null);
  // входящие предложения союза (очередь)
  const [proposals, setProposals] = useState<{ from: number; name: string }[]>([]);
  const [relVer, setRelVer] = useState(0); // счётчик смены отношений (для перерисовки меню)

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const gcRef = useRef<GameClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ratioRef = useRef(ratio);
  const phaseRef = useRef(phase);
  const troopHistory = useRef<number[]>([]); // история войск для графика прироста
  const liveTroops = useRef(0); // актуальные войска (обновляются каждый тик)
  const liveMoney = useRef(0);
  const buildModeRef = useRef<BuildingType | null>(null);
  buildModeRef.current = buildMode;
  const nukeKindRef = useRef<string | null>(null);
  nukeKindRef.current = nukeKind;
  const fleetModeRef = useRef(false);
  fleetModeRef.current = fleetMode;
  const canFleetRef = useRef(false); // хватает ли денег на боевой корабль
  const canBuildHqRef = useRef(false);
  const canBuildPortRef = useRef(false);
  const canBuildCityRef = useRef(false);
  const canBuildFactoryRef = useRef(false);
  const canBuildSiloRef = useRef(false);
  const canBuildSamRef = useRef(false);
  const nukeAffordRef = useRef<Record<string, boolean>>({}); // по типу ракеты: хватает ли на пуск
  const needFocus = useRef(false); // отложенный автозум к спавну
  const speedRef = useRef(1);
  speedRef.current = speed;
  const playersRef = useRef<PlayerPub[]>([]);
  // снимок армии/золота для рейтинга — обновляется раз в 5с
  const statSnap = useRef<Map<number, { max: number; money: number }>>(new Map());
  const [shownTroops, setShownTroops] = useState(0); // отображаемое значение (реже)
  const [fps, setFps] = useState(0);
  const [growthView, setGrowthView] = useState<{ rate: number; points: number[] }>({
    rate: 0,
    points: [],
  });
  ratioRef.current = ratio;
  phaseRef.current = phase;

  if (!gcRef.current) gcRef.current = new GameClient();
  const gc = gcRef.current;
  gc.buildMode = buildMode; // синхронизируем режим постройки с движком
  gc.nukeKind = nukeKind; // и режим наведения ракеты (тип или null)
  gc.fleetMode = fleetMode; // и режим выпуска боевого корабля
  // карту рисуем только в игре — в меню/лобби канвас не перерисовываем (экономим кадры)
  gc.active = phase === 'spawn' || phase === 'playing' || phase === 'dead';

  const sendMsg = (msg: object) => wsRef.current?.send(JSON.stringify(msg));

  useEffect(() => {
    const detach = gc.attach(canvasRef.current!);
    const detachMini = gc.attachMinimap(miniRef.current!);
    gc.onCellClick = (cell, sx, sy) => {
      setInvadeMenu(null);
      if (phaseRef.current === 'spawn') {
        sendMsg({ type: 'spawn', cell });
      } else if (phaseRef.current === 'playing') {
        // режим наведения ракеты — клик = пуск выбранного типа в цель
        if (nukeKindRef.current) {
          sendMsg({ type: 'nuke', cell, kind: nukeKindRef.current });
          setNukeKind(null);
          return;
        }
        // режим флота — клик = выпустить боевой корабль из ближайшего порта в зону
        if (fleetModeRef.current) {
          sendMsg({ type: 'warship', cell });
          setFleetMode(false);
          return;
        }
        // клик по своему зданию — меню прокачки, иначе атака
        const myHq = gc.buildingAt(cell);
        if (myHq && myHq.owner === gc.selfId && myHq.progress >= 1) {
          setUpgradeMenu({ cell, x: sx, y: sy, level: myHq.level });
        } else {
          sendMsg({ type: 'attack', cell, ratio: ratioRef.current / 100 });
        }
      }
    };
    // правый клик / два пальца по суше — меню морского вторжения.
    // Если попали в воду у берега (мелкий остров легко промахнуться) — подтягиваем
    // к ближайшей клетке суши в небольшом радиусе, чтобы десант на Ирландию и
    // прочие острова не срывался из-за промаха на пиксель.
    gc.onCellRightClick = (cell, sx, sy) => {
      if (phaseRef.current !== 'playing') return;
      let c = cell;
      if (!gc.terrain[c]) {
        const cx = c % gc.w;
        const cy = (c / gc.w) | 0;
        let best = -1;
        let bestD = Infinity;
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= gc.w || y >= gc.h) continue;
            const n = y * gc.w + x;
            if (!gc.terrain[n]) continue;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          }
        }
        if (best < 0) return; // рядом суши нет — это открытое море
        c = best;
      }
      if (gc.owners[c] === gc.selfId) return;
      setInvadeMenu({ cell: c, x: sx, y: sy });
    };
    // клик в режиме постройки — ставим здание и выходим из режима
    gc.onBuild = (cell) => {
      if (buildModeRef.current) sendMsg({ type: 'build', bt: buildModeRef.current, cell });
      setBuildMode(null);
    };
    // приказ выделенным боевым кораблям — идти в точку (и патрулировать её)
    gc.onFleetMove = (cell) => {
      const ids = [...gc.selectedWarships];
      if (ids.length) sendMsg({ type: 'warshipMove', ids, cell });
    };

    // VITE_WS_URL — для раздельного хостинга (клиент на GitHub Pages, сервер отдельно).
    // Без неё — старое поведение: через https-туннель (cloudflared/ngrok) wss на том же хосте.
    const wsUrl =
      import.meta.env.VITE_WS_URL ||
      (location.protocol === 'https:'
        ? `wss://${location.host}`
        : `ws://${location.hostname}:${PORT}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    let hudTick = 0; // троттлинг React-обновлений HUD (canvas берёт данные из gc)
    ws.onmessage = (ev) => {
      const msg: ServerMsg = JSON.parse(ev.data);
      if (msg.type === 'lobby') {
        setLobby(msg);
        setPhase('lobby');
      } else if (msg.type === 'init') {
        gc.applyInit(msg.selfId, msg.w, msg.h, msg.terrainRle, msg.ownersRle);
        gc.setPlayers(msg.players);
        setPlayers(msg.players);
        setRoomCode(msg.code);
        setSpawnLeft(msg.spawnSeconds ?? null);
        setWinner(null); // новый раунд (в т.ч. после реванша) — закрываем модалку
        if (msg.selfId > 0) setPhase('spawn');
      } else if (msg.type === 'update') {
        // защищаемся от отсутствующих полей (напр. старый сервер) — иначе краш
        const upAttacks = msg.attacks ?? [];
        const upBoats = msg.boats ?? [];
        const upBuildings = msg.buildings ?? [];
        gc.applyUpdate(msg.changes);
        // отложенный автозум к спавну — когда клетки уже пришли
        if (needFocus.current && gc.focusSelfSmooth()) needFocus.current = false;
        gc.setAttacks(upAttacks);
        gc.setBoats(upBoats);
        gc.setBuildings(upBuildings);
        gc.setShips(msg.ships ?? []);
        gc.setTrucks(msg.trucks ?? []);
        gc.setWarships(msg.warships ?? []);
        gc.setShots(msg.shots ?? []);
        gc.setMissiles(msg.missiles ?? []);
        gc.addEarnings(msg.earnings ?? []);
        // HUD (панели React) обновляем через раз (~5 Гц) — canvas рисует из gc и
        // остаётся плавным, а полная перерисовка App реже нагружает главный поток
        if ((hudTick++ & 1) === 0) {
          setAttacks(upAttacks);
          setBoats(upBoats);
          setBuildings(upBuildings);
          setSpeed(msg.speed ?? 1);
          setHumans(msg.humans ?? 1);
        }
        // список игроков сервер шлёт реже (раз в 500мс) — обрабатываем, когда есть
        const pl = msg.players;
        if (pl && pl.length) {
          gc.setPlayers(pl);
          playersRef.current = pl;
          setPlayers(pl);
          if (gc.selfId > 0) {
            const me = pl.find((p) => p.id === gc.selfId);
            if (me) {
              liveTroops.current = me.troops;
              liveMoney.current = me.money ?? 0;
              const h = troopHistory.current;
              h.push(me.troops);
              if (h.length > 120) h.shift();
            }
          }
        }
      } else if (msg.type === 'relations') {
        gc.setRelations(msg.allies ?? [], msg.enemies ?? []);
        setRelVer((v) => v + 1);
      } else if (msg.type === 'proposal') {
        // входящее предложение союза — показываем, избегая дублей
        setProposals((q) => (q.some((p) => p.from === msg.from) ? q : [...q, { from: msg.from, name: msg.name }]));
      } else if (msg.type === 'resync') {
        gc.resync(msg.ownersRle); // полный снимок владельцев после лага
      } else if (msg.type === 'spawned') {
        setPhase('playing');
        // клетки спавна придут следующим update — фокус делаем там (см. ниже)
        needFocus.current = true;
      } else if (msg.type === 'roundStart') {
        setSpawnLeft(null);
      } else if (msg.type === 'dead') {
        troopHistory.current = [];
        setPhase('dead');
      } else if (msg.type === 'winner') {
        setWinner({ name: msg.name, you: msg.id === gc.selfId });
      } else if (msg.type === 'error') {
        setError(msg.message);
        setTimeout(() => setError(null), 4000);
      }
    };
    return () => {
      detach();
      detachMini();
      ws.close();
    };
  }, []);

  // обратный отсчёт фазы выбора спавна
  useEffect(() => {
    if (spawnLeft === null || spawnLeft <= 0) return;
    const t = setTimeout(() => setSpawnLeft((s) => (s !== null ? s - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [spawnLeft]);

  // счётчики и график обновляем визуально раз в 1с — оптимизация,
  // чтобы числа не мельтешили каждый тик
  useEffect(() => {
    const iv = setInterval(() => {
      setShownTroops(liveTroops.current);
      setShownMoney(liveMoney.current);
      setFps(gc.fps);
      const h = troopHistory.current;
      const rate = h.length > 30 ? Math.round((h[h.length - 1] - h[h.length - 31]) / 3) : 0;
      setGrowthView({ rate, points: h.slice() });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // рейтинг: армию и золото обновляем раз в 5с (оптимизация + меньше мельтешит)
  useEffect(() => {
    const iv = setInterval(() => {
      const m = new Map<number, { max: number; money: number }>();
      for (const p of playersRef.current) m.set(p.id, { max: p.maxTroops, money: p.money });
      statSnap.current = m;
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  const cleanName = () => {
    const n = name.trim() || 'Аноним';
    localStorage.setItem('wf-name', n);
    return n;
  };

  const leaveToMenu = () => {
    sendMsg({ type: 'leave' });
    gc.selfId = -1;
    gc.setAttacks([]);
    setPhase('menu');
    setMenuView('main');
    setLobby(null);
    setSpawnLeft(null);
    setWinner(null);
    troopHistory.current = [];
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  // Escape: сначала отменяет режим постройки, затем из игры/лобби — в меню
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (nukeKindRef.current) {
          setNukeKind(null);
          return;
        }
        if (buildModeRef.current) {
          setBuildMode(null);
          return;
        }
        if (fleetModeRef.current) {
          setFleetMode(false);
          return;
        }
        if (gc.selectedWarships.size) {
          gc.selectedWarships.clear(); // снять выделение флота
          return;
        }
        // в игре Esc — переключатель паузы (второй раз продолжает игру)
        if (phaseRef.current === 'playing') {
          sendMsg({ type: 'setSpeed', speed: speedRef.current === 0 ? 1 : 0 });
          return;
        }
        if (phaseRef.current === 'menu') setMenuView('main');
        else leaveToMenu();
        return;
      }
      // хоткеи панели 1–0 (в игре): здания (1 город,3 порт,4 штаб,5 шахта,6 ПВО) и ракеты (8,9)
      if (phaseRef.current === 'playing' && /^[0-9]$/.test(e.key)) {
        const idx = e.key === '0' ? 9 : +e.key - 1;
        const nk = TOOLS[idx]?.nuke;
        if (nk) {
          // ☢️/💥 — режим наведения выбранной ракеты
          if (nukeAffordRef.current[nk]) {
            setBuildMode(null);
            setNukeKind((k) => (k === nk ? null : nk));
          }
          return;
        }
        if (TOOLS[idx]?.fleet) {
          // 🚢 — режим выпуска боевого корабля
          if (canFleetRef.current) {
            setBuildMode(null);
            setNukeKind(null);
            setFleetMode((f) => !f);
          }
          return;
        }
        const bt = TOOLS[idx]?.bt;
        // не хватает денег — префаб выбрать нельзя
        if (bt === 'hq' && !canBuildHqRef.current) return;
        if (bt === 'port' && !canBuildPortRef.current) return;
        if (bt === 'city' && !canBuildCityRef.current) return;
        if (bt === 'factory' && !canBuildFactoryRef.current) return;
        if (bt === 'silo' && !canBuildSiloRef.current) return;
        if (bt === 'sam' && !canBuildSamRef.current) return;
        if (bt) {
          setNukeKind(null);
          setBuildMode((bm) => (bm === bt ? null : bt));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const quickPlay = () => sendMsg({ type: 'quick', name: cleanName() });
  const createLobby = () =>
    sendMsg({ type: 'create', name: cleanName(), difficulty, map: mapType });
  const joinLobby = () =>
    sendMsg({ type: 'joinLobby', name: cleanName(), code: joinCode });

  const copyCode = () => {
    if (!lobby) return;
    navigator.clipboard.writeText(lobby.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const self = players.find((p) => p.id === gc.selfId);
  const committed = attacks
    .filter((a) => a.player === gc.selfId)
    .reduce((s, a) => s + a.troops, 0);
  const nameOf = (id: number) => players.find((p) => p.id === id)?.name ?? '?';
  // мои десанты (куда плыву) и вражеские (кто плывёт ко мне)
  const myBoats = boats.filter((b) => b.player === gc.selfId);
  const incoming = boats.filter((b) => b.target === gc.selfId);
  const board = players
    .filter((p) => p.alive && p.cells > 0)
    .sort((a, b) => b.cells - a.cells)
    .slice(0, 8);
  const totalCells = players.reduce((s, p) => s + (p.alive ? p.cells : 0), 0) || 1;
  const inGame = phase === 'spawn' || phase === 'playing' || phase === 'dead';
  // экономика: мои штабы, цена следующего, сколько войск уйдёт в атаку
  const myHqs = buildings.filter((b) => b.owner === gc.selfId && b.type === 'hq').length;
  const myPorts = buildings.filter((b) => b.owner === gc.selfId && b.type === 'port').length;
  const myCities = buildings.filter((b) => b.owner === gc.selfId && b.type === 'city').length;
  const myFactories = buildings.filter((b) => b.owner === gc.selfId && b.type === 'factory').length;
  const myFactoryLevels = buildings
    .filter((b) => b.owner === gc.selfId && b.type === 'factory')
    .reduce((s, b) => s + b.level, 0);
  const nextFactoryCost = factoryCost(myFactoryLevels);
  const mySilos = buildings.filter((b) => b.owner === gc.selfId && b.type === 'silo').length;
  const mySams = buildings.filter((b) => b.owner === gc.selfId && b.type === 'sam').length;
  // суммарный уровень ПВО → цена следующей покупки (в общем)
  const mySamLevels = buildings
    .filter((b) => b.owner === gc.selfId && b.type === 'sam')
    .reduce((s, b) => s + b.level, 0);
  const nextSamCost = samCost(mySamLevels);
  // суммарный заряд достроенных шахт (сколько ракет готово к пуску)
  const nukeAmmo = buildings.reduce(
    (s, b) => (b.owner === gc.selfId && b.type === 'silo' && b.progress >= 1 ? s + b.ammo : s),
    0
  );
  const nukeReady = nukeAmmo > 0;
  // суммарный уровень моих городов → цена следующей покупки города (в общем)
  const myCityLevels = buildings
    .filter((b) => b.owner === gc.selfId && b.type === 'city')
    .reduce((s, b) => s + b.level, 0);
  const nextCityCost = cityCost(myCityLevels);
  const nextHqCost = hqCost(myHqs);
  // превью выделенных на атаку — от ЖИВОГО числа войск (обновляется каждый тик),
  // чтобы сразу менялось после клика, а не ждало троттлинг счётчика
  const attackTroops = Math.floor(((self?.troops ?? shownTroops) * ratio) / 100);
  canBuildHqRef.current = shownMoney >= nextHqCost;
  // порт можно выбрать (клавиша 3), если хватает на новый ИЛИ на апгрейд своего
  const cheapestPortUpg = buildings
    .filter((b) => b.owner === gc.selfId && b.type === 'port')
    .reduce((min, b) => Math.min(min, portUpgradeCost(b.level + 1)), Infinity);
  canBuildPortRef.current = shownMoney >= Math.min(PORT_BUILD_COST, cheapestPortUpg);
  // город (клавиша 1): и постройка, и апгрейд стоят одинаково — по сумме уровней
  canBuildCityRef.current = shownMoney >= nextCityCost;
  // завод (клавиша 2): постройка/апгрейд по сумме уровней
  canBuildFactoryRef.current = shownMoney >= nextFactoryCost;
  // шахта (клавиша 5): постройка и апгрейд по 1млн
  canBuildSiloRef.current = shownMoney >= SILO_COST;
  // ПВО (клавиша 6): постройка/апгрейд по сумме уровней
  canBuildSamRef.current = shownMoney >= nextSamCost;
  // ракеты (8/9): нужна заряженная шахта и деньги на пуск конкретного типа
  nukeAffordRef.current = {
    basic: nukeReady && shownMoney >= NUKES.basic.cost,
    hydro: nukeReady && shownMoney >= NUKES.hydro.cost,
  };
  // боевой флот (7): 1-й 250к, 2-й 500к, дальше по 1млн; нужен свой порт
  const myWarshipCount = gc.warships.filter((w) => w.owner === gc.selfId).length;
  const nextWarshipCost =
    myWarshipCount === 0 ? 250_000 : myWarshipCount === 1 ? 500_000 : 1_000_000;
  canFleetRef.current = shownMoney >= nextWarshipCost && myPorts > 0;

  return (
    <div className="app">
      <canvas ref={canvasRef} className="map" />
      <canvas ref={miniRef} className="minimap" style={{ display: inGame ? 'block' : 'none' }} />

      <div className="fps" title="Кадров в секунду">{fps} FPS</div>

      {inGame && (
        <div className="ctrl-panel">
          {/* пауза и ускорение — только когда ты один (без реальных игроков) */}
          {humans <= 1 && (
            <>
              <button
                className="ctrl-btn"
                title={speed === 0 ? 'Продолжить' : 'Пауза'}
                onClick={() => sendMsg({ type: 'setSpeed', speed: speed === 0 ? 1 : 0 })}
              >
                {speed === 0 ? '▶' : '⏸'}
              </button>
              {[1, 2, 3, 10].map((s) => (
                <button
                  key={s}
                  className={'ctrl-btn ctrl-speed' + (speed === s ? ' active' : '')}
                  onClick={() => sendMsg({ type: 'setSpeed', speed: s })}
                >
                  {s}×
                </button>
              ))}
            </>
          )}
          <button className="ctrl-btn" title="Полный экран" onClick={toggleFullscreen}>
            ⛶
          </button>
          <button className="ctrl-btn ctrl-exit" title="Выйти в меню" onClick={leaveToMenu}>
            ✕
          </button>
        </div>
      )}

      {inGame && (
        <div className="panel leaderboard">
          <div className="eyebrow">
            Лидеры{roomCode !== 'QUICK' && <span className="room-code"> · {roomCode}</span>}
          </div>
          {board.map((p, i) => {
            const stat = statSnap.current.get(p.id);
            return (
              <div key={p.id} className={'lb-row' + (p.id === gc.selfId ? ' me' : '')}>
                <span className="lb-rank">{i + 1}</span>
                <span className="dot" style={{ background: playerColorCSS(p.id) }} />
                <span className="lb-name">
                  {p.name}
                  {p.bot && !p.strong ? ' 🤖' : ''}
                </span>
                <span className="lb-val">{((p.cells / totalCells) * 100).toFixed(1)}%</span>
                <span className="lb-stat">🪖 {fmtK(stat?.max ?? p.maxTroops)}</span>
                <span className="lb-stat lb-gold">◈ {fmtK(stat?.money ?? p.money)}</span>
              </div>
            );
          })}
        </div>
      )}

      {phase === 'spawn' && (
        <div className="spawn-banner">
          Кликните по свободной земле — выберите точку высадки
          {spawnLeft !== null && spawnLeft > 0 && (
            <span className="timer"> {spawnLeft}с</span>
          )}
        </div>
      )}
      {phase === 'playing' && spawnLeft !== null && spawnLeft > 0 && (
        <div className="spawn-banner">
          Ждём высадки остальных<span className="timer"> {spawnLeft}с</span>
        </div>
      )}

      {phase === 'playing' && self && (
        <div className="hud-stack">
          {incoming.length > 0 && (
            <div className="incoming">
              {incoming.map((b) => (
                <button
                  key={b.id}
                  className="incoming-row"
                  onClick={() => gc.focusOn(b.path[0] ?? b.x, b.path[1] ?? b.y)}
                  title="Показать агрессора"
                >
                  <span className="inc-dot" style={{ background: playerColorCSS(b.player) }} />
                  <span className="inc-text">
                    🚢 <b>{b.troops.toLocaleString('ru')}</b> плывёт от {nameOf(b.player)}
                  </span>
                  <span className="inc-focus">⌖</span>
                </button>
              ))}
            </div>
          )}
          {myBoats.length > 0 && (
            <div className="myboats">
              {myBoats.map((b) => (
                <span key={b.id} className="myboat">
                  🚢 {b.troops.toLocaleString('ru')} → {nameOf(b.target) === '?' ? 'берег' : nameOf(b.target)}
                  <button
                    className="myboat-recall"
                    title="Отозвать десант"
                    onClick={() => sendMsg({ type: 'recall', boatId: b.id })}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {buildMode === 'hq' && (
            <div className="build-hint">
              Кликните по своей внутренней клетке — поставить штаб (Esc — отмена)
            </div>
          )}
          {buildMode === 'port' && (
            <div className="build-hint">
              Кликните по своему берегу — порт; рядом с портом — апгрейд (Esc — отмена)
            </div>
          )}
          {buildMode === 'city' && (
            <div className="build-hint">
              Кликните в глубине своей земли — город (+лимит войск); рядом с городом — апгрейд (Esc)
            </div>
          )}
          {buildMode === 'factory' && (
            <div className="build-hint">
              Кликните в глубине своей земли — завод (ускоряет реген в радиусе + грузовики возят золото по дорогам к городам/портам); рядом с заводом — апгрейд (Esc)
            </div>
          )}
          {buildMode === 'silo' && (
            <div className="build-hint">
              Кликните в глубине своей земли — ракетная шахта; рядом с шахтой — апгрейд (Esc)
            </div>
          )}
          {buildMode === 'sam' && (
            <div className="build-hint">
              Кликните в глубине своей земли — ПВО (сбивает ракеты); рядом с ПВО — апгрейд (Esc)
            </div>
          )}
          {nukeKind && (
            <div className="build-hint nuke-hint">
              🎯 Цель для «{NUKES[nukeKind].name}» — вылетит из ближайшей шахты ({fmtK(NUKES[nukeKind].cost)}). Esc — отмена
            </div>
          )}
          {fleetMode && (
            <div className="build-hint">
              🚢 Кликните точку в море — боевой корабль выйдет из ближайшего порта и займёт зону ({fmtK(nextWarshipCost)}). Клик по кораблю — выделить, Shift+клик — несколько, затем клик по точке — приказ идти. Esc — отмена
            </div>
          )}
          <div className="panel hud">
            <div className="hud-top">
              <span className="growth-chip">
                🪖 {growthView.rate >= 0 ? '+' : ''}
                {growthView.rate}/с
              </span>
              <div className="troop-wrap">
                <div
                  className="troop-fill"
                  style={{
                    width: `${Math.min(100, (self.troops / self.maxTroops) * 100)}%`,
                    background: playerColorCSS(self.id),
                  }}
                />
                <span className="troop-nums">
                  {fmtK(shownTroops)} / {fmtK(self.maxTroops)} 🧍
                  {committed > 0 && <span className="committed"> ⚔ {fmtK(committed)}</span>}
                </span>
              </div>
              <span className="gold-chip">◈ {fmtK(shownMoney)}</span>
            </div>

            <label className="ratio">
              <span className="ratio-val">
                ⚔ {ratio}% ({fmtK(attackTroops)})
              </span>
              <input
                type="range"
                min={5}
                max={100}
                value={ratio}
                onChange={(e) => setRatio(+e.target.value)}
              />
            </label>

            <div className="toolbar">
              {TOOLS.map((t, i) => {
                const nk = t.nuke; // тип ракеты (☢️/💥) — действие пуска
                const active =
                  !!nk || !!t.fleet || t.bt === 'hq' || t.bt === 'port' || t.bt === 'city' || t.bt === 'factory' || t.bt === 'silo' || t.bt === 'sam';
                const cost = nk
                  ? NUKES[nk].cost
                  : t.fleet
                    ? nextWarshipCost
                    : t.bt === 'port'
                      ? PORT_BUILD_COST
                      : t.bt === 'city'
                        ? nextCityCost
                        : t.bt === 'factory'
                          ? nextFactoryCost
                          : t.bt === 'silo'
                            ? SILO_COST
                            : t.bt === 'sam'
                              ? nextSamCost
                              : nextHqCost;
                const count = nk
                  ? nukeAmmo
                  : t.fleet
                    ? myWarshipCount
                    : t.bt === 'port'
                      ? myPorts
                      : t.bt === 'city'
                        ? myCities
                        : t.bt === 'factory'
                          ? myFactories
                          : t.bt === 'silo'
                            ? mySilos
                            : t.bt === 'sam'
                              ? mySams
                              : t.bt === 'hq'
                                ? myHqs
                                : 0;
                const afford = nk
                  ? nukeAffordRef.current[nk]
                  : t.fleet
                    ? canFleetRef.current
                    : t.bt === 'port'
                      ? canBuildPortRef.current
                      : t.bt === 'city'
                        ? canBuildCityRef.current
                        : t.bt === 'factory'
                          ? canBuildFactoryRef.current
                          : t.bt === 'silo'
                            ? canBuildSiloRef.current
                            : t.bt === 'sam'
                              ? canBuildSamRef.current
                              : shownMoney >= cost;
                const usable = active && afford;
                const selected = nk ? nukeKind === nk : t.fleet ? fleetMode : buildMode === t.bt && active;
                return (
                  <button
                    key={i}
                    className={
                      'tool' + (usable ? '' : ' disabled') + (selected ? ' selected' : '')
                    }
                    disabled={!usable}
                    title={
                      active
                        ? `${t.name} · ${fmtK(cost)}${afford ? '' : (nk ? ' — нужна заряженная шахта' : ' — не хватает денег')}`
                        : `${t.name} — скоро`
                    }
                    onClick={() => {
                      if (!usable) return;
                      if (nk) {
                        setBuildMode(null);
                        setFleetMode(false);
                        setNukeKind((k) => (k === nk ? null : nk));
                      } else if (t.fleet) {
                        setBuildMode(null);
                        setNukeKind(null);
                        setFleetMode((f) => !f);
                      } else if (t.bt) {
                        setNukeKind(null);
                        setFleetMode(false);
                        setBuildMode(selected ? null : t.bt);
                      }
                    }}
                  >
                    <span className="tool-key">{(i + 1) % 10}</span>
                    <span className="tool-icon">{t.icon}</span>
                    <span className="tool-count">{count}</span>
                    {active && <span className="tool-cost">{fmtK(cost)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {phase === 'playing' && speed === 0 && (
        <div className="pause-banner">⏸ Пауза · Esc — продолжить</div>
      )}

      {phase === 'menu' && (
        <MenuScreen
          name={name}
          setName={setName}
          menuView={menuView}
          setMenuView={setMenuView}
          connected={connected}
          mapType={mapType}
          setMapType={setMapType}
          difficulty={difficulty}
          setDifficulty={setDifficulty}
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          error={error}
          onQuick={quickPlay}
          onCreate={createLobby}
          onJoin={joinLobby}
        />
      )}

      {phase === 'lobby' && lobby && (
        <LobbyScreen
          lobby={lobby}
          copied={copied}
          onCopyCode={copyCode}
          onStart={() => sendMsg({ type: 'start' })}
          onLeave={leaveToMenu}
        />
      )}

      {phase === 'dead' && (
        <DeadScreen onRespawn={() => sendMsg({ type: 'respawn' })} onLeave={leaveToMenu} />
      )}

      {invadeMenu && (
        <>
          <div className="menu-scrim" onClick={() => setInvadeMenu(null)} />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(invadeMenu.x, window.innerWidth - 220),
              top: Math.min(invadeMenu.y, window.innerHeight - 120),
            }}
          >
            <div className="ctx-title">
              Цель:{' '}
              {gc.owners[invadeMenu.cell] === 0
                ? 'нейтральный берег'
                : nameOf(gc.owners[invadeMenu.cell])}
            </div>
            {(() => {
              void relVer; // перерисовка при смене отношений
              const owner = gc.owners[invadeMenu.cell];
              const rel = owner > 0 ? gc.relationOf(owner) : 'neutral';
              return (
                <>
                  {rel === 'allied' ? (
                    <div className="ctx-note">🤝 Союзник — атаковать нельзя</div>
                  ) : (
                    <>
                      <button
                        className="ctx-btn"
                        disabled={myBoats.length >= 3}
                        onClick={() => {
                          if (myBoats.length >= 3) return;
                          sendMsg({ type: 'invade', cell: invadeMenu.cell, ratio: ratio / 100 });
                          setInvadeMenu(null);
                        }}
                      >
                        🚢 Морское вторжение · {Math.min(50, ratio)}%
                      </button>
                      {myBoats.length >= 3 && (
                        <div className="ctx-note">🚢 Лимит: 3 корабля в пути</div>
                      )}
                    </>
                  )}
                  {owner > 0 && rel === 'allied' && (
                    <button
                      className="ctx-btn"
                      onClick={() => {
                        sendMsg({ type: 'breakAlliance', cell: invadeMenu.cell });
                        setInvadeMenu(null);
                      }}
                    >
                      💔 Расторгнуть союз
                    </button>
                  )}
                  {owner > 0 && rel !== 'allied' && (
                    <button
                      className="ctx-btn"
                      onClick={() => {
                        sendMsg({ type: 'propose', cell: invadeMenu.cell });
                        setInvadeMenu(null);
                      }}
                    >
                      🤝 Предложить союз
                    </button>
                  )}
                </>
              );
            })()}
            <button className="ctx-cancel" onClick={() => setInvadeMenu(null)}>
              Отмена
            </button>
          </div>
        </>
      )}

      {proposals.length > 0 && phase === 'playing' && (
        <div className="proposals">
          {proposals.map((p) => (
            <div className="proposal-card" key={p.from}>
              <div className="proposal-text">
                🤝 <b>{p.name}</b> предлагает союз
              </div>
              <div className="proposal-actions">
                <button
                  className="ctx-btn"
                  onClick={() => {
                    sendMsg({ type: 'allianceResponse', from: p.from, accept: true });
                    setProposals((q) => q.filter((x) => x.from !== p.from));
                  }}
                >
                  Принять
                </button>
                <button
                  className="ctx-cancel"
                  onClick={() => {
                    sendMsg({ type: 'allianceResponse', from: p.from, accept: false });
                    setProposals((q) => q.filter((x) => x.from !== p.from));
                  }}
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {upgradeMenu && (
        <>
          <div className="menu-scrim" onClick={() => setUpgradeMenu(null)} />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(upgradeMenu.x, window.innerWidth - 220),
              top: Math.min(upgradeMenu.y, window.innerHeight - 120),
            }}
          >
            {(() => {
              const b = gc.buildingAt(upgradeMenu.cell);
              const lvl = b?.level ?? upgradeMenu.level;
              if (b?.type === 'silo') {
                const upgrading = (b.upProgress ?? 0) > 0;
                return (
                  <>
                    <div className="ctx-title">🚀 Ракетная шахта · ур. {lvl}</div>
                    <div className="ctx-note">
                      Залп: {b.ammo}/{lvl} ракет · апгрейд +1 к залпу
                    </div>
                    {upgrading ? (
                      <div className="ctx-note">Улучшается…</div>
                    ) : (
                      <button
                        className="ctx-btn"
                        disabled={shownMoney < SILO_COST}
                        onClick={() => {
                          sendMsg({ type: 'upgrade', cell: upgradeMenu.cell });
                          setUpgradeMenu(null);
                        }}
                      >
                        ⚡ До {lvl + 1} ур. · {fmtK(SILO_COST)} · 5с
                      </button>
                    )}
                  </>
                );
              }
              if (b?.type === 'sam') {
                const upgrading = (b.upProgress ?? 0) > 0;
                return (
                  <>
                    <div className="ctx-title">🛰️ ПВО · ур. {lvl}</div>
                    <div className="ctx-note">
                      Перехватов: {b.ammo}/{lvl} · апгрейд +1 к перехвату
                    </div>
                    {upgrading ? (
                      <div className="ctx-note">Улучшается…</div>
                    ) : (
                      <button
                        className="ctx-btn"
                        disabled={shownMoney < nextSamCost}
                        onClick={() => {
                          sendMsg({ type: 'upgrade', cell: upgradeMenu.cell });
                          setUpgradeMenu(null);
                        }}
                      >
                        ⚡ До {lvl + 1} ур. · {fmtK(nextSamCost)} · 5с
                      </button>
                    )}
                  </>
                );
              }
              if (b?.type === 'city') {
                const toLevel = lvl + 1;
                const cost = nextCityCost;
                return (
                  <>
                    <div className="ctx-title">🏙️ Город · ур. {lvl}</div>
                    <div className="ctx-note">
                      Лимит войск: +{fmtK(cityTroopBonus(lvl))} → +{fmtK(cityTroopBonus(toLevel))}
                    </div>
                    <button
                      className="ctx-btn"
                      disabled={shownMoney < cost}
                      onClick={() => {
                        sendMsg({ type: 'upgrade', cell: upgradeMenu.cell });
                        setUpgradeMenu(null);
                      }}
                    >
                      ⚡ До {toLevel} ур. · {fmtK(cost)}
                    </button>
                  </>
                );
              }
              if (b?.type === 'factory') {
                const toLevel = lvl + 1;
                const cost = nextFactoryCost;
                return (
                  <>
                    <div className="ctx-title">🏭 Завод · ур. {lvl}</div>
                    <div className="ctx-note">
                      Ускоряет реген в радиусе · грузовики возят золото (10к за здание) · +3% к регену за каждые 10 ур.
                    </div>
                    <button
                      className="ctx-btn"
                      disabled={shownMoney < cost}
                      onClick={() => {
                        sendMsg({ type: 'upgrade', cell: upgradeMenu.cell });
                        setUpgradeMenu(null);
                      }}
                    >
                      ⚡ До {toLevel} ур. · {fmtK(cost)}
                    </button>
                  </>
                );
              }
              if (b?.type === 'port') {
                const toLevel = lvl + 1;
                const cost = portUpgradeCost(toLevel);
                return (
                  <>
                    <div className="ctx-title">⚓ Торговый порт · ур. {lvl}</div>
                    <div className="ctx-note">
                      Кораблей: {shipsForLevel(lvl)} · дальше — дороже доставка
                    </div>
                    <button
                      className="ctx-btn"
                      disabled={shownMoney < cost}
                      onClick={() => {
                        sendMsg({ type: 'upgrade', cell: upgradeMenu.cell });
                        setUpgradeMenu(null);
                      }}
                    >
                      ⚡ До {toLevel} ур. · {fmtK(cost)}
                    </button>
                  </>
                );
              }
              const upgrading = (b?.upProgress ?? 0) > 0;
              const toLevel = lvl + 1;
              const cost = hqUpgradeCost(toLevel);
              return (
                <>
                  <div className="ctx-title">🛡 Штаб обороны · ур. {lvl}</div>
                  {upgrading ? (
                    <div className="ctx-note">Улучшается…</div>
                  ) : lvl >= MAX_HQ_LEVEL ? (
                    <div className="ctx-note">Максимальный уровень — усиленный взрыв</div>
                  ) : (
                    <button
                      className="ctx-btn"
                      disabled={shownMoney < cost}
                      onClick={() => {
                        sendMsg({ type: 'upgrade', cell: upgradeMenu.cell });
                        setUpgradeMenu(null);
                      }}
                    >
                      ⚡ До {toLevel} ур. · {fmtK(cost)} · {toLevel === 2 ? '5с' : '10с'}
                    </button>
                  )}
                </>
              );
            })()}
            <button className="ctx-cancel" onClick={() => setUpgradeMenu(null)}>
              Закрыть
            </button>
          </div>
        </>
      )}

      {winner && (
        <WinnerModal
          winner={winner}
          onRematch={() => sendMsg({ type: 'rematch' })}
          onContinue={() => setWinner(null)}
          onLeave={leaveToMenu}
        />
      )}
    </div>
  );
}
