import { defineConfig } from 'vitest/config';
// The hub tests drive real git repos; on a loaded studio host one can take
// several seconds, so the timeout is sized for the tail, not the median.
export default defineConfig({ test: { include: ['tests/**/*.test.mjs'], testTimeout: 60_000 } });
