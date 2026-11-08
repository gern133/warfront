import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './command.css'; // главный экран и HUD-«фишки» поверх базовых стилей

createRoot(document.getElementById('root')!).render(<App />);
