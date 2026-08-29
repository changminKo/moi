import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => {
  const apiTarget = process.env.MOI_DEV_API_ORIGIN ?? 'http://localhost:3000';
  const proxy = {
    '/api': {
      target: apiTarget,
      ws: true,
    },
  };
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
