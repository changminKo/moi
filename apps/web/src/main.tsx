import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app';
import { SessionProvider } from './features/session/session-provider';
import { queryClient } from './lib/query-client';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/shell.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Moi root element is missing');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
