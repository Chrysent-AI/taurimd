import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ReaderController } from './controller';
import { native } from './native';
import { parseInWorker } from './reader/worker';
import './style.css';
const root = document.getElementById('root');
if (!root) throw new Error('Reader root is missing.');
const controller = new ReaderController(native, parseInWorker);
window.addEventListener('beforeunload', () => {
  controller.dispose();
});
createRoot(root).render(<App controller={controller} />);
