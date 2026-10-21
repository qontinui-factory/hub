// One `hub publish` / `hub unpublish` at a time per clone: an O_EXCL lockfile
// under the clone's git dir holding the owner's pid, host and purpose. A lock
// whose pid is gone on this host is stale and is taken over ATOMICALLY: it is
// renamed aside, re-read, and discarded only if it still holds the stale
// holder's text; a lock that changed hands meanwhile is put back and refused.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Take the lock at `<gitDir>/hub.lock`; returns a release function.
 * `hooks.afterStaleRead` runs between reading a stale holder and moving it
 * aside (tests interleave a second taker there).
 */
export function acquireLock(gitDir, { what = 'hub', log = () => {}, hooks = {} } = {}) {
  const path = join(gitDir, 'hub.lock');
  const me = `${process.pid} ${hostname()} ${what} ${new Date().toISOString()} ${randomBytes(4).toString('hex')}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, me, { flag: 'wx', mode: 0o600 });
      return () => {
        if (read(path) === me) rmSync(path, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = read(path);
    if (holder === null) continue; // released between the two calls
    const [pid, host] = holder.split(' ');
    if (!(host === hostname() && Number(pid) > 0 && !alive(Number(pid)))) {
      throw new HubError('refused', `another hub command holds ${path} (${holder.trim() || 'unreadable'}); re-run when it finishes`);
    }
    hooks.afterStaleRead?.();
    const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
    try {
      renameSync(path, aside);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // another taker moved it first
      throw err;
    }
    if (read(aside) !== holder) {
      // We moved someone else's fresh lock: put it back without clobbering.
      try {
        linkSync(aside, path);
      } catch {}
      rmSync(aside, { force: true });
      throw new HubError('refused', `${path} changed hands while a stale lock was being replaced; re-run when the other hub command finishes`);
    }
    rmSync(aside, { force: true });
    log(`removed a stale hub lock (pid ${pid} is gone): ${holder.trim()}`);
  }
  throw new HubError('refused', `could not take ${path}`);
}
