// Оверлеи конца: поражение и победа

export function DeadScreen({ onRespawn, onLeave }: { onRespawn: () => void; onLeave: () => void }) {
  return (
    <div className="overlay">
      <div className="menu">
        <h1 className="title">Разбиты</h1>
        <div className="frontline" aria-hidden="true" />
        <p className="dead-msg">Ваша территория захвачена</p>
        <button className="primary" onClick={onRespawn}>
          Реванш
        </button>
        <button className="link" onClick={onLeave}>
          В меню
        </button>
      </div>
    </div>
  );
}

interface WinnerProps {
  winner: { name: string; you: boolean };
  onRematch: () => void;
  onContinue: () => void;
  onLeave: () => void;
}

export function WinnerModal({ winner, onRematch, onContinue, onLeave }: WinnerProps) {
  return (
    <div className="overlay">
      <div className="menu">
        <h1 className="title">{winner.you ? 'Победа!' : 'Раунд окончен'}</h1>
        <div className="frontline" aria-hidden="true" />
        <p className="dead-msg">
          {winner.you ? (
            <>Вы захватили мир 🏆</>
          ) : (
            <>
              🏆 <b>{winner.name}</b> захватил контроль над миром
            </>
          )}
        </p>
        <button className="primary" onClick={onRematch}>
          Реванш — новая карта
        </button>
        <button className="secondary" onClick={onContinue}>
          Продолжить играть
        </button>
        <button className="link" onClick={onLeave}>
          В меню
        </button>
      </div>
    </div>
  );
}
