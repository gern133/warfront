import { Difficulty, MapType } from '../../shared/protocol';
import { MenuView } from '../types';
import { DIFF_LABELS, MAP_LABELS } from '../constants/ui';

interface Props {
  name: string;
  setName: (v: string) => void;
  menuView: MenuView;
  setMenuView: (v: MenuView) => void;
  connected: boolean;
  mapType: MapType;
  setMapType: (m: MapType) => void;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  joinCode: string;
  setJoinCode: (v: string) => void;
  error: string | null;
  onQuick: () => void;
  onCreate: () => void;
  onJoin: () => void;
}

// Главное меню: быстрая игра, создание лобби, вход по коду
export function MenuScreen(p: Props) {
  return (
    <div className="overlay">
      <div className="menu">
        <h1 className="title">Warfront</h1>
        <div className="frontline" aria-hidden="true" />
        <label className="field">
          <span className="eyebrow">Позывной</span>
          <input
            placeholder="Ваше имя"
            value={p.name}
            maxLength={16}
            onChange={(e) => p.setName(e.target.value)}
          />
        </label>
        {p.menuView === 'main' && (
          <>
            <button className="primary" onClick={p.onQuick} disabled={!p.connected}>
              В бой
            </button>
            <button className="secondary" onClick={() => p.setMenuView('create')} disabled={!p.connected}>
              Создать лобби
            </button>
            <button className="secondary" onClick={() => p.setMenuView('join')} disabled={!p.connected}>
              Войти по коду
            </button>
            {!p.connected && <p className="hint">Подключение к серверу…</p>}
          </>
        )}
        {p.menuView === 'create' && (
          <>
            <div className="field">
              <span className="eyebrow">Театр действий</span>
              <div className="opt-list">
                {(Object.keys(MAP_LABELS) as MapType[]).map((m) => (
                  <label key={m} className={'opt' + (p.mapType === m ? ' active' : '')}>
                    <input type="radio" name="map" checked={p.mapType === m} onChange={() => p.setMapType(m)} />
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
                  <label key={d} className={'opt' + (p.difficulty === d ? ' active' : '')}>
                    <input type="radio" name="diff" checked={p.difficulty === d} onChange={() => p.setDifficulty(d)} />
                    <span className="opt-name">{DIFF_LABELS[d].name}</span>
                    <span className="opt-desc">{DIFF_LABELS[d].desc}</span>
                  </label>
                ))}
              </div>
            </div>
            <button className="primary" onClick={p.onCreate} disabled={!p.connected}>
              Создать лобби
            </button>
            <button className="link" onClick={() => p.setMenuView('main')}>
              ← Назад
            </button>
          </>
        )}
        {p.menuView === 'join' && (
          <>
            <label className="field">
              <span className="eyebrow">Шифр доступа</span>
              <input
                className="code-input"
                placeholder="•••••"
                value={p.joinCode}
                maxLength={5}
                onChange={(e) => p.setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && p.onJoin()}
              />
            </label>
            <button className="primary" onClick={p.onJoin} disabled={!p.connected || p.joinCode.length < 5}>
              Войти
            </button>
            <button className="link" onClick={() => p.setMenuView('main')}>
              ← Назад
            </button>
          </>
        )}
        {p.error && <p className="error">{p.error}</p>}
      </div>
    </div>
  );
}
