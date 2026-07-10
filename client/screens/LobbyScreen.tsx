import { LobbyInfo } from '../types';
import { DIFF_LABELS, MAP_LABELS } from '../constants/ui';

interface Props {
  lobby: LobbyInfo;
  copied: boolean;
  onCopyCode: () => void;
  onStart: () => void;
  onLeave: () => void;
}

// Лобби: код доступа, список игроков, старт (у хоста)
export function LobbyScreen({ lobby, copied, onCopyCode, onStart, onLeave }: Props) {
  return (
    <div className="overlay">
      <div className="menu">
        <h1 className="title">Лобби</h1>
        <div className="frontline" aria-hidden="true" />
        <div className="field">
          <span className="eyebrow">Шифр доступа — отправьте союзникам</span>
          <button className="code-box" onClick={onCopyCode}>
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
          <button className="primary" onClick={onStart}>
            Начать игру
          </button>
        ) : (
          <p className="hint">Ожидание хоста…</p>
        )}
        <button className="link" onClick={onLeave}>
          Покинуть лобби
        </button>
      </div>
    </div>
  );
}
