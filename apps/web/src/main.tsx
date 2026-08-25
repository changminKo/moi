import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app';
import './styles/globals.css';
import './styles/tokens.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Skipjack root element is missing');
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
