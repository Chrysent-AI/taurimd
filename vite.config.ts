import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/**'] } },
  build: { outDir: 'src-tauri/frontend-dist' },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
