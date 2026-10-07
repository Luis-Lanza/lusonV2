import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  cacheDir: '.cache/vite',
  test: {
    environment: 'jsdom', setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'e2e/binding.test.ts', 'e2e/l05-binding.test.ts'],
  },
});
