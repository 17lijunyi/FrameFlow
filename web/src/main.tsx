import {createRoot} from 'react-dom/client';
import App from './App';
import './styles.css';
import './liquidGlass.css';
import {applyTheme, THEME_STORAGE_KEY} from './theme';

applyTheme('light');
try {
  window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
} catch {
  // Local storage can be unavailable in hardened browser contexts.
}

createRoot(document.getElementById('root')!).render(<App />);
