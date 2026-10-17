// Builds /_hub/ui-bridge.js, the one UI Bridge boot script every hub page and
// every launch-bundle page loads (plan AE2, AI4.3).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/boot/ui-bridge.jsx'],
  bundle: true,
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'public/_hub/ui-bridge.js',
  logLevel: 'warning',
});
console.log('boot script built');
