import { Difficulty } from '../../shared/protocol';
import { MenuView } from '../types';
import { DIFF_LABELS } from '../constants/ui';
import { WorldDots } from './WorldDots';

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

// Знак игры: квадрат, разделённый «ступенчатой» линией фронта — как граница
// территорий на пиксельной карте в самой игре
function Mark() {
  return (
    <svg className="home-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M24 0V24H0V18H6V12H12V6H18V0Z" fill="var(--signal)" />
      <rect x="0.75" y="0.75" width="22.5" height="22.5" fill="none" stroke="var(--khaki)" strokeWidth="1.5" />
    </svg>
  );
}

// Главный экран: слева колонка меню, справа — карта мира
export function MenuScreen(p: Props) {
  const sub = p.menuView !== 'main';
  return (
    <div className="home">
      <WorldDots className="home-map" />
      <div className="home-shade" aria-hidden="true" />

      <main className="home-side">
        <header className="home-brand">
          <Mark />
          <h1 className="home-title">Warfront</h1>
          <p className="home-sub">
            Стратегия захвата территорий в реальном времени. До 100 игроков на одной карте мира.
          </p>
        </header>

        <section className="home-body">
          {sub && (
            <div className="home-subhead">
              <button className="home-back" onClick={() => p.setMenuView('main')}>
                ← Главное меню
              </button>
              <h2 className="home-h2">{p.menuView === 'create' ? 'Новое лобби' : 'Вход по коду'}</h2>
            </div>
          )}

          <label className="home-field">
            <span className="home-label">Позывной</span>
            <input
              placeholder="Как вас называть"
              value={p.name}
              maxLength={16}
              onChange={(e) => p.setName(e.target.value)}
            />
          </label>

          {p.menuView === 'main' && (
            <>
              <button className="home-primary" onClick={p.onQuick} disabled={!p.connected}>
                <span className="home-primary-main">Быстрая игра</span>
                <span className="home-primary-sub">Общая комната · сразу в бой</span>
                <span className="home-arrow" aria-hidden="true">→</span>
              </button>
              <nav className="home-list">
                <button className="home-item" onClick={() => p.setMenuView('create')} disabled={!p.connected}>
                  <span className="home-item-main">Создать лобби</span>
                  <span className="home-item-sub">Своя сложность, код для друзей</span>
                  <span className="home-arrow" aria-hidden="true">→</span>
                </button>
                <button className="home-item" onClick={() => p.setMenuView('join')} disabled={!p.connected}>
                  <span className="home-item-main">Войти по коду</span>
                  <span className="home-item-sub">Пять символов от хоста лобби</span>
                  <span className="home-arrow" aria-hidden="true">→</span>
                </button>
              </nav>
            </>
          )}

          {p.menuView === 'create' && (
            <>
              <div className="home-field">
                <span className="home-label">Сложность</span>
                <div className="home-diffs" role="radiogroup">
                  {DIFFS.map((d) => (
                    <label key={d} className={'home-diff' + (p.difficulty === d ? ' active' : '')}>
                      <input
                        type="radio"
                        name="diff"
                        checked={p.difficulty === d}
                        onChange={() => p.setDifficulty(d)}
                      />
                      <span className="home-diff-body">
                        <span className="home-diff-name">{DIFF_LABELS[d].name}</span>
                        <span className="home-diff-desc">{DIFF_LABELS[d].desc}</span>
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
              <button className="home-primary" onClick={p.onCreate} disabled={!p.connected}>
                <span className="home-primary-main">Создать лобби</span>
                <span className="home-arrow" aria-hidden="true">→</span>
              </button>
            </>
          )}

          {p.menuView === 'join' && (
            <>
              <label className="home-field">
                <span className="home-label">Код лобби</span>
                <input
                  className="home-code"
                  placeholder="•••••"
                  value={p.joinCode}
                  maxLength={5}
                  onChange={(e) => p.setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && p.onJoin()}
                />
              </label>
              <button
                className="home-primary"
                onClick={p.onJoin}
                disabled={!p.connected || p.joinCode.length < 5}
              >
                <span className="home-primary-main">Войти в лобби</span>
                <span className="home-arrow" aria-hidden="true">→</span>
              </button>
            </>
          )}

          {p.error && <p className="error">{p.error}</p>}
        </section>

        <footer className="home-foot">
          <span className={'home-status' + (p.connected ? ' on' : '')}>
            {p.connected ? 'Сервер на связи' : 'Подключение…'}
          </span>
          <span>Карта: Земля</span>
        </footer>
      </main>
    </div>
  );
}
