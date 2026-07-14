import { LobbyInfo } from '../types';
import { DIFF_LABELS, MAP_LABELS } from '../constants/ui';

interface Props {
  lobby: LobbyInfo;
  copied: boolean;
  onCopyLink: () => void;
  onStart: () => void;
  onLeave: () => void;
}

// Лобби: ссылка-приглашение, список игроков, старт (у хоста)
export function LobbyScreen({ lobby, copied, onCopyLink, onStart, onLeave }: Props) {
  return (
    <div className="overlay">
      <div className="menu">
        <div className="menu-head">
          <span className="menu-eyebrow">Оперативный штаб</span>
          <h1 className="title">Лобби</h1>
          <div className="frontline" aria-hidden="true" />
          <span className="lobby-meta">
            {MAP_LABELS[lobby.map].name} · {DIFF_LABELS[lobby.difficulty].name.toLowerCase()} уровень
          </span>
        </div>

        <div className="field">
          <span className="eyebrow">Пригласить союзника — отправьте ссылку</span>
          <button className={'invite-btn' + (copied ? ' copied' : '')} onClick={onCopyLink}>
            <span className="invite-ico" aria-hidden="true">🔗</span>
            <span className="invite-text">
              <span className="invite-main">{copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</span>
              <span className="invite-sub">код · {lobby.code}</span>
            </span>
            <span className="invite-mark">{copied ? '✓' : 'копировать'}</span>
          </button>
        </div>

        <div className="field">
          <span className="eyebrow">Командиры в лобби · {lobby.players.length}</span>
          <div className="lobby-players">
            {lobby.players.map((n, i) => (
              <div key={i} className="lobby-player">
                <span className="lobby-rank">{i + 1}</span>
                <span className="lobby-pname">{n}</span>
                {i === 0 && <span className="lobby-host">хост</span>}
              </div>
            ))}
          </div>
        </div>

        {lobby.host ? (
          <button className="primary" onClick={onStart}>
            Начать операцию<span className="btn-chev">→</span>
          </button>
        ) : (
          <p className="hint">Ожидание запуска хостом…</p>
        )}
        <button className="link" onClick={onLeave}>
          Покинуть лобби
        </button>
      </div>
    </div>
  );
}
