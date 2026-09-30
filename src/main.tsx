import { createRoot } from 'react-dom/client';
import App from './App';
import './app/styles/fonts.css';
import './app/styles/base.css';
import './app/styles/app.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root tidak ditemukan di index.html');
}
createRoot(container).render(<App />);
