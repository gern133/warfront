import { memo, useEffect, useRef, useState } from 'react';
import {
  PlayerPub,
  AttackPub,
  BoatPub,
  ServerMsg,
  PORT,
  Difficulty,
  MapType,
} from '../shared/protocol';
import { playerColorCSS } from '../shared/color';
import { GameClient } from './game-client';

type Phase = 'menu' | 'lobby' | 'spawn' | 'playing' | 'dead';
type MenuView = 'main' | 'create' | 'join';

interface LobbyInfo {
  code: string;
  host: boolean;
  difficulty: Difficulty;
  map: MapType;
  players: string[];
}

// Ботов всегда 300 (275 пассивного «корма» + 25 стран); сложность меняет силу
// стран относительно игрока
const DIFF_LABELS: Record<Difficulty, { name: string; desc: string }> = {
  easy: { name: 'Лёгкий', desc: 'страны слабее вас' },
  normal: { name: 'Средний', desc: 'страны как вы' },
  hard: { name: 'Тяжёлый', desc: 'страны на 20% сильнее' },
  insane: { name: 'Безумный', desc: 'страны на 50% сильнее' },
};

const MAP_LABELS: Record<MapType, { name: string; desc: string }> = {
  random: { name: 'Случайный мир', desc: 'новые континенты каждый раунд' },
  earth: { name: 'Земля', desc: 'реальные материки и острова' },
};

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
  const [spawnLeft, setSpawnLeft] = useState<number | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ratio, setRatio] = useState(30);
  const [connected, setConnected] = useState(false);
  const [invadeMenu, setInvadeMenu] = useState<{ cell: number; x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const gcRef = useRef<GameClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ratioRef = useRef(ratio);
  const phaseRef = useRef(phase);
  const troopHistory = useRef<number[]>([]); // история войск для графика прироста
  const liveTroops = useRef(0); // актуальные войска (обновляются каждый тик)
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

  const sendMsg = (msg: object) => wsRef.current?.send(JSON.stringify(msg));

  useEffect(() => {
    const detach = gc.attach(canvasRef.current!);
    const detachMini = gc.attachMinimap(miniRef.current!);
    gc.onCellClick = (cell) => {
      setInvadeMenu(null);
      if (phaseRef.current === 'spawn') {
        sendMsg({ type: 'spawn', cell });
      } else if (phaseRef.current === 'playing') {
        sendMsg({ type: 'attack', cell, ratio: ratioRef.current / 100 });
      }
    };
    // правый клик / два пальца по суше — меню морского вторжения
    gc.onCellRightClick = (cell, sx, sy) => {
      if (phaseRef.current !== 'playing') return;
      if (!gc.terrain[cell] || gc.owners[cell] === gc.selfId) return;
      setInvadeMenu({ cell, x: sx, y: sy });
    };

    // через https-туннель (cloudflared/ngrok) — wss на том же хосте
    const wsUrl =
      location.protocol === 'https:'
        ? `wss://${location.host}`
        : `ws://${location.hostname}:${PORT}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
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
        if (msg.selfId > 0) setPhase('spawn');
      } else if (msg.type === 'update') {
        gc.applyUpdate(msg.changes);
        gc.setPlayers(msg.players);
        gc.setAttacks(msg.attacks);
        gc.setBoats(msg.boats);
        setPlayers(msg.players);
        setAttacks(msg.attacks);
        setBoats(msg.boats);
        // копим историю войск для графика прироста (последние ~12 с при 100мс)
        if (gc.selfId > 0) {
          const me = msg.players.find((p) => p.id === gc.selfId);
          if (me) {
            liveTroops.current = me.troops;
            const h = troopHistory.current;
            h.push(me.troops);
            if (h.length > 120) h.shift();
          }
        }
      } else if (msg.type === 'spawned') {
        setPhase('playing');
      } else if (msg.type === 'roundStart') {
        setSpawnLeft(null);
      } else if (msg.type === 'dead') {
        troopHistory.current = [];
        setPhase('dead');
      } else if (msg.type === 'winner') {
        setWinner(msg.name);
        setTimeout(() => setWinner(null), 7500);
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
      setFps(gc.fps);
      const h = troopHistory.current;
      const rate = h.length > 30 ? Math.round((h[h.length - 1] - h[h.length - 31]) / 3) : 0;
      setGrowthView({ rate, points: h.slice() });
    }, 1000);
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

  // Escape: из игры/лобби — в меню, в меню — назад к главному экрану
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (phaseRef.current === 'menu') setMenuView('main');
      else leaveToMenu();
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

  return (
    <div className="app">
      <canvas ref={canvasRef} className="map" />
      <canvas ref={miniRef} className="minimap" style={{ display: inGame ? 'block' : 'none' }} />

      <div className="fps" title="Кадров в секунду">{fps} FPS</div>

      {inGame && (
        <button className="exit-btn" onClick={leaveToMenu} title="Esc — выход в меню">
          ⎋ В меню
        </button>
      )}

      {inGame && (
        <div className="panel leaderboard">
          <div className="eyebrow">
            Лидеры{roomCode !== 'QUICK' && <span className="room-code"> · {roomCode}</span>}
          </div>
          {board.map((p, i) => (
            <div key={p.id} className={'lb-row' + (p.id === gc.selfId ? ' me' : '')}>
              <span className="lb-rank">{i + 1}</span>
              <span className="dot" style={{ background: playerColorCSS(p.id) }} />
              <span className="lb-name">
                {p.name}
                {p.bot && !p.strong ? ' 🤖' : ''}
              </span>
              <span className="lb-val">{((p.cells / totalCells) * 100).toFixed(1)}%</span>
            </div>
          ))}
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
          <div className="panel hud">
            <Sparkline
              data={growthView.points}
              max={self.maxTroops}
              color={playerColorCSS(self.id)}
              rate={growthView.rate}
            />
            <div className="troops">
              {shownTroops.toLocaleString('ru')}
              <span className="troops-max"> / {self.maxTroops.toLocaleString('ru')}</span>
              {committed > 0 && (
                <span className="committed"> ⚔ {committed.toLocaleString('ru')}</span>
              )}
            </div>
          <div className="troop-bar">
            <div
              className="troop-fill"
              style={{
                width: `${Math.min(100, (self.troops / self.maxTroops) * 100)}%`,
                background: playerColorCSS(self.id),
              }}
            />
          </div>
          <label className="ratio">
            <span className="ratio-label">В атаку</span>
            <input
              type="range"
              min={5}
              max={100}
              value={ratio}
              onChange={(e) => setRatio(+e.target.value)}
            />
            <span className="ratio-val">{ratio}%</span>
          </label>
          </div>
        </div>
      )}

      {phase === 'menu' && (
        <div className="overlay">
          <div className="menu">
            <h1 className="title">Warfront</h1>
            <div className="frontline" aria-hidden="true" />
            <label className="field">
              <span className="eyebrow">Позывной</span>
              <input
                placeholder="Ваше имя"
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {menuView === 'main' && (
              <>
                <button className="primary" onClick={quickPlay} disabled={!connected}>
                  В бой
                </button>
                <button className="secondary" onClick={() => setMenuView('create')} disabled={!connected}>
                  Создать лобби
                </button>
                <button className="secondary" onClick={() => setMenuView('join')} disabled={!connected}>
                  Войти по коду
                </button>
                {!connected && <p className="hint">Подключение к серверу…</p>}
              </>
            )}
            {menuView === 'create' && (
              <>
                <div className="field">
                  <span className="eyebrow">Театр действий</span>
                  <div className="opt-list">
                    {(Object.keys(MAP_LABELS) as MapType[]).map((m) => (
                      <label key={m} className={'opt' + (mapType === m ? ' active' : '')}>
                        <input
                          type="radio"
                          name="map"
                          checked={mapType === m}
                          onChange={() => setMapType(m)}
                        />
                        <span className="opt-name">{MAP_LABELS[m].name}</span>
                        <span className="opt-desc">{MAP_LABELS[m].desc}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span className="eyebrow">Уровень угрозы</span>
                  <div className="opt-list">
                    {(Object.keys(DIFF_LABELS) as Difficulty[]).map((d) => (
                      <label key={d} className={'opt' + (difficulty === d ? ' active' : '')}>
                        <input
                          type="radio"
                          name="diff"
                          checked={difficulty === d}
                          onChange={() => setDifficulty(d)}
                        />
                        <span className="opt-name">{DIFF_LABELS[d].name}</span>
                        <span className="opt-desc">{DIFF_LABELS[d].desc}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <button className="primary" onClick={createLobby} disabled={!connected}>
                  Создать лобби
                </button>
                <button className="link" onClick={() => setMenuView('main')}>
                  ← Назад
                </button>
              </>
            )}
            {menuView === 'join' && (
              <>
                <label className="field">
                  <span className="eyebrow">Шифр доступа</span>
                  <input
                    className="code-input"
                    placeholder="•••••"
                    value={joinCode}
                    maxLength={5}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && joinLobby()}
                  />
                </label>
                <button className="primary" onClick={joinLobby} disabled={!connected || joinCode.length < 5}>
                  Войти
                </button>
                <button className="link" onClick={() => setMenuView('main')}>
                  ← Назад
                </button>
              </>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      )}

      {phase === 'lobby' && lobby && (
        <div className="overlay">
          <div className="menu">
            <h1 className="title">Лобби</h1>
            <div className="frontline" aria-hidden="true" />
            <div className="field">
              <span className="eyebrow">Шифр доступа — отправьте союзникам</span>
              <button className="code-box" onClick={copyCode}>
                {lobby.code}
                <span className="copy-mark">{copied ? '✓ скопировано' : 'копировать'}</span>
              </button>
            </div>
            <div className="lobby-meta">
              {MAP_LABELS[lobby.map].name} · {DIFF_LABELS[lobby.difficulty].name.toLowerCase()} уровень
            </div>
            <div className="lobby-players">
              {lobby.players.map((n, i) => (
                <div key={i} className="lobby-player">
                  {n}
                </div>
              ))}
            </div>
            {lobby.host ? (
              <button className="primary" onClick={() => sendMsg({ type: 'start' })}>
                Начать игру
              </button>
            ) : (
              <p className="hint">Ожидание хоста…</p>
            )}
            <button className="link" onClick={leaveToMenu}>
              Покинуть лобби
            </button>
          </div>
        </div>
      )}

      {phase === 'dead' && (
        <div className="overlay">
          <div className="menu">
            <h1 className="title">Разбиты</h1>
            <div className="frontline" aria-hidden="true" />
            <p className="dead-msg">Ваша территория захвачена</p>
            <button className="primary" onClick={() => sendMsg({ type: 'respawn' })}>
              Реванш
            </button>
            <button className="link" onClick={leaveToMenu}>
              В меню
            </button>
          </div>
        </div>
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
            <button
              className="ctx-btn"
              onClick={() => {
                sendMsg({ type: 'invade', cell: invadeMenu.cell, ratio: ratio / 100 });
                setInvadeMenu(null);
              }}
            >
              🚢 Морское вторжение · {ratio}%
            </button>
            <button className="ctx-cancel" onClick={() => setInvadeMenu(null)}>
              Отмена
            </button>
          </div>
        </>
      )}

      {winner && <div className="winner">🏆 {winner} — контроль над миром. Новый раунд через 8 с</div>}
    </div>
  );
}

// График роста войск: залитая область истории + метка прироста в секунду.
// memo — перерисовывается только при смене снимка данных (раз в 0.5с).
const Sparkline = memo(function Sparkline({
  data,
  max,
  color,
  rate,
}: {
  data: number[];
  max: number;
  color: string;
  rate: number;
}) {
  const W = 200;
  const H = 40;
  const n = data.length;
  const top = Math.max(max, ...(n ? data : [1]), 1);
  const pts =
    n > 1
      ? data.map((v, i) => `${(i / (n - 1)) * W},${H - (v / top) * H}`).join(' ')
      : '';
  return (
    <div className="growth">
      <span className="growth-label">Прирост войск</span>
      <svg className="growth-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {pts && (
          <>
            <polyline points={`0,${H} ${pts} ${W},${H}`} fill={color} opacity="0.18" />
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
          </>
        )}
      </svg>
      <span className="growth-rate" style={{ color: rate >= 0 ? '#7dd18b' : '#ff6a55' }}>
        {rate >= 0 ? '+' : ''}
        {rate.toLocaleString('ru')}/с
      </span>
    </div>
  );
});
