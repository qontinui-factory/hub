// The repository carries the files every build relies on.
// The build itself (D1 sha check, A1 guard) runs as its own ci.toml step.
import { existsSync } from 'node:fs';

const required = ['README.md', 'LICENSE', '.gitignore', '.qontinui/ci.toml', 'package.json', 'pnpm-lock.yaml', 'exhibits.yaml'];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`ok: ${required.length} required files present`);
