import { Difficulty } from '../../shared/protocol';
import { MenuView } from '../types';
import { DIFF_LABELS } from '../constants/ui';

interface Props {
  name: string;
  setName: (v: string) => void;
  menuView: MenuView;
  setMenuView: (v: MenuView) => void;
  connected: boolean;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  joinCode: string;
  setJoinCode: (v: string) => void;
  error: string | null;
  onQuick: () => void;
  onCreate: () => void;
  onJoin: () => void;
}

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard', 'insane'];
const THREAT: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3, insane: 4 };

// Главное меню: быстрая игра, создание операции, вход по коду
export function MenuScreen(p: Props) {
  return (
    <div className="overlay">
      <div className="menu">
        <div className="menu-head">
          <span className="menu-eyebrow">Мировой театр военных действий</span>
          <h1 className="title">Warfront</h1>
          <div className="frontline" aria-hidden="true" />
          <span className="menu-tagline">Захвати планету — регион за регионом</span>
        </div>

        <label className="field">
          <span className="eyebrow">Позывной командующего</span>
          <input
            placeholder="Введите имя"
            value={p.name}
            maxLength={16}
            onChange={(e) => p.setName(e.target.value)}
          />
        </label>

        {p.menuView === 'main' && (
          <>
            <button className="primary" onClick={p.onQuick} disabled={!p.connected}>
              В бой<span className="btn-chev">→</span>
            </button>
            <div className="menu-split">
              <button className="secondary" onClick={() => p.setMenuView('create')} disabled={!p.connected}>
                Создать операцию
              </button>
              <button className="secondary" onClick={() => p.setMenuView('join')} disabled={!p.connected}>
                Войти по коду
              </button>
            </div>
            <p className="hint">
              {p.connected ? 'Сервер на связи · карта: Земля' : 'Установка связи с сервером…'}
            </p>
          </>
        )}

        {p.menuView === 'create' && (
          <>
            <div className="field">
              <span className="eyebrow">Уровень угрозы</span>
              <div className="opt-list">
                {DIFFS.map((d) => (
                  <label key={d} className={'opt' + (p.difficulty === d ? ' active' : '')}>
                    <input type="radio" name="diff" checked={p.difficulty === d} onChange={() => p.setDifficulty(d)} />
                    <span className="opt-body">
                      <span className="opt-name">{DIFF_LABELS[d].name}</span>
                      <span className="opt-desc">{DIFF_LABELS[d].desc}</span>
                    </span>
                    <span className="threat" aria-hidden="true">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={'threat-dot' + (i < THREAT[d] ? ' on' : '')} />
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <button className="primary" onClick={p.onCreate} disabled={!p.connected}>
              Развернуть лобби<span className="btn-chev">→</span>
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
              Войти в лобби<span className="btn-chev">→</span>
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
