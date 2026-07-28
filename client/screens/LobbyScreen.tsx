import { LobbyInfo } from '../types';
import { DIFF_LABELS, MAP_LABELS } from '../constants/ui';

interface Props {
  lobby: LobbyInfo;
  copied: boolean;
  onCopyLink: () => void;
  onSetSettings: (infMoney: boolean, infArmy: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
}

// Лобби: ссылка-приглашение, список игроков, настройки карты, старт (у хоста)
export function LobbyScreen({ lobby, copied, onCopyLink, onSetSettings, onStart, onLeave }: Props) {
  const s = lobby.settings;
  const multiplayer = lobby.players.length > 1;
  const canEdit = lobby.host && !multiplayer; // песочные настройки — только в одиночку
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

        <div className="field">
          <span className="eyebrow">Настройки карты</span>
          <div className="opt-list">
            <label className={'setting-row' + (s.infMoney ? ' on' : '') + (canEdit ? '' : ' locked')}>
              <input
                type="checkbox"
                checked={s.infMoney}
                disabled={!canEdit}
                onChange={(e) => onSetSettings(e.target.checked, s.infArmy)}
              />
              <span className="setting-body">
                <span className="setting-name">Бесконечные деньги</span>
                <span className="setting-desc">фиксировано 100 млн</span>
              </span>
            </label>
            <label className={'setting-row' + (s.infArmy ? ' on' : '') + (canEdit ? '' : ' locked')}>
              <input
                type="checkbox"
                checked={s.infArmy}
                disabled={!canEdit}
                onChange={(e) => onSetSettings(s.infMoney, e.target.checked)}
              />
              <span className="setting-body">
                <span className="setting-name">Бесконечная армия</span>
                <span className="setting-desc">потолок 100 млн, набор постепенный</span>
              </span>
            </label>
          </div>
          {multiplayer && (
            <span className="setting-note">Доступно только в одиночной игре</span>
          )}
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
