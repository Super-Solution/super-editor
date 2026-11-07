import { createRoot } from 'react-dom/client';
import '@supersolutions/super-editor-ui/styles.css';
import './demo.css';
import { App } from './demo/App.js';

createRoot(document.getElementById('root')!).render(<App />);
