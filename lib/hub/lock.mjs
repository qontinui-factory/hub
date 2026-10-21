// One `hub publish` / `hub unpublish` at a time per clone: an O_EXCL lockfile
// under the clone's git dir holding the owner's pid and host. A lock whose pid
// is gone on this host is stale and is replaced; a live one refuses.
import { hostname } from 'node:os';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HubError } from './roots.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Take the lock at `<gitDir>/hub.lock`; returns a release function. */
export function acquireLock(gitDir, { what = 'hub', log = () => {} } = {}) {
  const path = join(gitDir, 'hub.lock');
  const me = `${process.pid} ${hostname()} ${what} ${new Date().toISOString()}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, me, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (readFileSync(path, 'utf8') === me) rmSync(path);
        } catch {}
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = '';
    try {
      holder = readFileSync(path, 'utf8');
    } catch {
      continue; // released between the two calls
    }
    const [pid, host] = holder.split(' ');
    if (host === hostname() && Number(pid) > 0 && !alive(Number(pid))) {
      log(`removing a stale hub lock (pid ${pid} is gone): ${holder.trim()}`);
      rmSync(path, { force: true });
      continue;
    }
    throw new HubError('refused', `another hub command holds ${path} (${holder.trim() || 'unreadable'}); re-run when it finishes`);
  }
  throw new HubError('refused', `could not take ${path}`);
}
