// The scenes web player needs the illustrative traces (fetched as untrusted
// JSON) and the bundled fonts under its assetBaseUrl (`<base>/fonts/`).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@qontinui/studio-scenes/package.json'));
mkdirSync('public/_hub/scenes', { recursive: true });
cpSync(join(root, 'traces', 'illustrative'), 'public/_hub/scenes/traces', { recursive: true });
cpSync(join(root, 'assets', 'fonts'), 'public/_hub/scenes/fonts', { recursive: true });
console.log('scene assets copied');
