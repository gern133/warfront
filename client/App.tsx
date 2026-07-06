import { useEffect, useRef, useState } from 'react';
import { PlayerPub, AttackPub, ServerMsg, PORT, Difficulty } from '../shared/protocol';
import { playerColorCSS } from '../shared/color';
import { GameClient } from './game-client';

type Phase = 'menu' | 'lobby' | 'spawn' | 'playing' | 'dead';
type MenuView = 'main' | 'create' | 'join';

interface LobbyInfo {
  code: string;
  host: boolean;
  difficulty: Difficulty;
  players: string[];
}

const DIFF_LABELS: Record<Difficulty, string> = {
  easy: 'Лёгкая — 50 ботов, из них 5 стран',
  normal: 'Средняя — 70 ботов, из них 15 стран',
  hard: 'Сложная — 90 ботов, из них 40 стран',
};

export default function App() {
  const [phase, setPhase] = useState<Phase>('menu');
  const [menuView, setMenuView] = useState<MenuView>('main');
  const [name, setName] = useState(() => localStorage.getItem('wf-name') || '');
  const [joinCode, setJoinCode] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [lobby, setLobby] = useState<LobbyInfo | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [players, setPlayers] = useState<PlayerPub[]>([]);
  const [attacks, setAttacks] = useState<AttackPub[]>([]);
  const [spawnLeft, setSpawnLeft] = useState<number | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ratio, setRatio] = useState(30);
  const [connected, setConnected] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const gcRef = useRef<GameClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ratioRef = useRef(ratio);
  const phaseRef = useRef(phase);
  ratioRef.current = ratio;
  phaseRef.current = phase;

  if (!gcRef.current) gcRef.current = new GameClient();
  const gc = gcRef.current;

  const sendMsg = (msg: object) => wsRef.current?.send(JSON.stringify(msg));

  useEffect(() => {
    const detach = gc.attach(canvasRef.current!);
    const detachMini = gc.attachMinimap(miniRef.current!);
    gc.onCellClick = (cell) => {
      if (phaseRef.current === 'spawn') {
        sendMsg({ type: 'spawn', cell });
      } else if (phaseRef.current === 'playing') {
        sendMsg({ type: 'attack', cell, ratio: ratioRef.current / 100 });
      }
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
        gc.applyInit(msg.selfId, msg.terrain, msg.owners);
        gc.setPlayers(msg.players);
        setPlayers(msg.players);
        setRoomCode(msg.code);
        setSpawnLeft(msg.spawnSeconds ?? null);
        if (msg.selfId > 0) setPhase('spawn');
      } else if (msg.type === 'update') {
        gc.applyUpdate(msg.changes);
        gc.setPlayers(msg.players);
        gc.setAttacks(msg.attacks);
        setPlayers(msg.players);
        setAttacks(msg.attacks);
      } else if (msg.type === 'spawned') {
        setPhase('playing');
      } else if (msg.type === 'roundStart') {
        setSpawnLeft(null);
      } else if (msg.type === 'dead') {
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

  const cleanName = () => {
    const n = name.trim() || 'Аноним';
    localStorage.setItem('wf-name', n);
    return n;
  };

  const quickPlay = () => sendMsg({ type: 'quick', name: cleanName() });
  const createLobby = () => sendMsg({ type: 'create', name: cleanName(), difficulty });
  const joinLobby = () =>
    sendMsg({ type: 'joinLobby', name: cleanName(), code: joinCode });

  const copyCode = () => {
    if (!lobby) return;
    navigator.clipboard.writeText(lobby.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const self = players.find((p) => p.id === gc.selfId);
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

      {inGame && (
        <div className="panel leaderboard">
          <div className="panel-title">
            Лидеры {roomCode !== 'QUICK' && <span className="room-code">· {roomCode}</span>}
          </div>
          {board.map((p) => (
            <div key={p.id} className={'lb-row' + (p.id === gc.selfId ? ' me' : '')}>
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
          🎯 Кликни по свободной земле — выбери точку старта
          {spawnLeft !== null && spawnLeft > 0 && ` · ${spawnLeft} c`}
        </div>
      )}
      {phase === 'playing' && spawnLeft !== null && spawnLeft > 0 && (
        <div className="spawn-banner">⏳ Ждём остальных игроков · {spawnLeft} c</div>
      )}

      {phase === 'playing' && self && (
        <div className="panel hud">
          <div className="troops">
            ⚔️ {self.troops.toLocaleString('ru')} / {self.maxTroops.toLocaleString('ru')}
            {(() => {
              const committed = attacks
                .filter((a) => a.player === gc.selfId)
                .reduce((s, a) => s + a.troops, 0);
              return committed > 0 ? (
                <span className="committed"> · в атаках {committed.toLocaleString('ru')}</span>
              ) : null;
            })()}
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
            В атаку: {ratio}%
            <input
              type="range"
              min={5}
              max={100}
              value={ratio}
              onChange={(e) => setRatio(+e.target.value)}
            />
          </label>
        </div>
      )}

      {phase === 'menu' && (
        <div className="overlay">
          <div className="menu">
            <h1>WARFRONT</h1>
            <input
              placeholder="Ваше имя"
              value={name}
              maxLength={16}
              onChange={(e) => setName(e.target.value)}
            />
            {menuView === 'main' && (
              <>
                <button onClick={quickPlay} disabled={!connected}>
                  ⚡ Быстрая игра
                </button>
                <button className="secondary" onClick={() => setMenuView('create')} disabled={!connected}>
                  🏰 Создать лобби
                </button>
                <button className="secondary" onClick={() => setMenuView('join')} disabled={!connected}>
                  🔑 Войти по коду
                </button>
                {!connected && <p className="hint">Подключение к серверу…</p>}
              </>
            )}
            {menuView === 'create' && (
              <>
                <div className="diff-list">
                  {(Object.keys(DIFF_LABELS) as Difficulty[]).map((d) => (
                    <label key={d} className={'diff' + (difficulty === d ? ' active' : '')}>
                      <input
                        type="radio"
                        name="diff"
                        checked={difficulty === d}
                        onChange={() => setDifficulty(d)}
                      />
                      {DIFF_LABELS[d]}
                    </label>
                  ))}
                </div>
                <button onClick={createLobby} disabled={!connected}>
                  Создать лобби
                </button>
                <button className="link" onClick={() => setMenuView('main')}>
                  ← Назад
                </button>
              </>
            )}
            {menuView === 'join' && (
              <>
                <input
                  placeholder="Код лобби"
                  value={joinCode}
                  maxLength={5}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && joinLobby()}
                />
                <button onClick={joinLobby} disabled={!connected || joinCode.length < 5}>
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
            <h1>ЛОББИ</h1>
            <div className="code-box" onClick={copyCode} title="Скопировать">
              {lobby.code} {copied ? '✓' : '⧉'}
            </div>
            <p className="hint">Отправь этот код друзьям</p>
            <div className="lobby-players">
              {lobby.players.map((n, i) => (
                <div key={i} className="lobby-player">
                  👤 {n}
                </div>
              ))}
            </div>
            <p className="hint">{DIFF_LABELS[lobby.difficulty]}</p>
            {lobby.host ? (
              <button onClick={() => sendMsg({ type: 'start' })}>▶ Начать игру</button>
            ) : (
              <p className="hint">Ожидание хоста…</p>
            )}
            <button className="link" onClick={() => location.reload()}>
              Покинуть лобби
            </button>
          </div>
        </div>
      )}

      {phase === 'dead' && (
        <div className="overlay">
          <div className="menu">
            <h1>WARFRONT</h1>
            <p className="dead-msg">Ваша империя пала! 💀</p>
            <button onClick={() => sendMsg({ type: 'respawn' })}>Реванш</button>
            <button className="link" onClick={() => location.reload()}>
              В меню
            </button>
          </div>
        </div>
      )}

      {winner && <div className="winner">🏆 {winner} захватил мир! Новый раунд через 8 сек…</div>}
    </div>
  );
}
