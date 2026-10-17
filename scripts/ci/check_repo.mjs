// Phase 0 check: the repository carries the files every later phase relies on.
// Phase 1 replaces this lane with the site build, the D1 sha check and the A1 guard.
import { existsSync } from 'node:fs';

const required = ['README.md', 'LICENSE', '.gitignore', '.qontinui/ci.toml'];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`ok: ${required.length} required files present`);
