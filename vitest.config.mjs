import { getViteConfig } from 'astro/config';
// getViteConfig lets a test import an .astro component and render it through
// Astro's container API (tests/exhibit-render.test.mjs).
// The hub tests drive real git repos; on a loaded studio host one can take
// several seconds, so the timeout is sized for the tail, not the median.
export default getViteConfig({ test: { include: ['tests/**/*.test.mjs'], testTimeout: 60_000 } });
