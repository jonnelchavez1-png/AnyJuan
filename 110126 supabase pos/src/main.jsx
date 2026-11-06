import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { offline } from './data/offline/manager.js';
import './styles.css';

// Open the on-device storage first, so sales and saved copies work from the very first screen.
offline.init().catch(() => {}).finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
