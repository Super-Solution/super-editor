import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import '@supersolutions/super-editor-ui/styles.css';
import './demo.css';
import { App } from './demo/App.js';

createRoot(document.getElementById('root')!).render(<App />);
