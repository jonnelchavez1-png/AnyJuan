import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only variables that start with VITE_ are ever put into the browser bundle.
export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, target: 'es2020' },
});
