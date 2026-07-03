import { defineConfig } from 'vitest/config';

// Plain Vitest config (no WXT/Vite plugin needed): classifier.ts and the other
// utils/*.ts modules are pure TypeScript with no browser API dependency (CLAUDE.md).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
