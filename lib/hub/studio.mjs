// The ONE adapter the hub calls the studio CLI through (plan AI1), plus the
// read of the studio DB's `launches` rows.
//
// The command is `HUB_STUDIO_CMD` (a JSON argv array) or, by default,
// `poetry -C ${STUDIO_ROOT} run studio --root ${STUDIO_ROOT}`. Every call is
// `<cmd> launch run <yaml> | launch unpublish --launch <id> | launch readopt --launch <id>`,
// so one DB (`${STUDIO_ROOT}/.studio/studio.db`, store.py/workspace.py)
// records every launch, as A3's one-device rule needs. `launch readopt` is
// being added to the studio in parallel (AD3, AF2): exit 0 is success and any
// other exit is a refusal.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HubError, studioDb } from './roots.mjs';

export function studioArgv(env, roots) {
  if (env.HUB_STUDIO_CMD) {
    let argv;
    try {
      argv = JSON.parse(env.HUB_STUDIO_CMD);
    } catch {
      throw new HubError('usage', 'HUB_STUDIO_CMD is not JSON (expected an argv array)');
    }
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) {
      throw new HubError('usage', 'HUB_STUDIO_CMD must be a non-empty JSON array of strings');
    }
    return argv;
  }
  return ['poetry', '-C', roots.STUDIO_ROOT, 'run', 'studio', '--root', roots.STUDIO_ROOT];
}

/** Run a child, echoing its output to `log` line by line; resolves {code, stdout}. */
export function runChild(argv, { cwd, env, log = () => {} } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const relay = (stream, keep) => {
      let buf = '';
      stream.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        if (keep) stdout += s;
        buf += s;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) log(`  studio| ${line}`);
      });
      stream.on('end', () => buf && log(`  studio| ${buf}`));
    };
    relay(child.stdout, true);
    relay(child.stderr, false);
    child.on('error', (err) => resolveRun({ code: 127, stdout, error: err.message }));
    child.on('close', (code, signal) => resolveRun({ code: code ?? (signal ? 128 : 1), stdout }));
  });
}

/**
 * The adapter. `childEnv` is the environment every studio call gets (the
 * roots, the bearer file, the active tenant). `run` is injectable for tests.
 */
export function makeStudio({ env = process.env, roots, childEnv = {}, run = runChild, log = () => {} }) {
  const base = () => studioArgv(env, roots);
  const call = (args, cwd) => run([...base(), ...args], { cwd, env: { ...env, ...childEnv }, log });
  return {
    argv: base,
    launchRun: (yaml, extra = []) => call(['launch', 'run', yaml, ...extra], roots.STUDIO_HUB_CLONE),
    unpublish: (id) => call(['launch', 'unpublish', '--launch', id], roots.STUDIO_HUB_CLONE),
    // Exit 0 readopted; 2 refused (`code`: not_unpublished, no_publish_dir,
    // launch_live, not_newest, bytes_differ, foreign_file); 1 not found or error.
    readopt: (id) => call(['launch', 'readopt', '--launch', id, '--json'], roots.STUDIO_HUB_CLONE),
  };
}

const COLUMNS = 'id, product_slug, status, publish_dir, published_files, published_at, superseded_by, unpublished_at, created_at';

/**
 * Every launch whose publish_dir is `dir`, newest first. A missing DB means
 * this host never launched anything, which is an empty list, said so.
 */
export function launchesAt(roots, dir, { log = () => {} } = {}) {
  const path = studioDb(roots);
  if (!existsSync(path)) {
    log(`no studio DB at ${path}: no launch has run on this host`);
    return [];
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(`SELECT ${COLUMNS} FROM launches WHERE publish_dir = ? ORDER BY created_at DESC, id DESC`)
      .all(dir)
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

export function launchById(roots, id) {
  const path = studioDb(roots);
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const r = db.prepare(`SELECT ${COLUMNS} FROM launches WHERE id = ?`).get(id);
    return r ? { ...r } : null;
  } finally {
    db.close();
  }
}

/** The JSON object a `--json` studio call printed last, or null. */
export function lastJson(stdout = '') {
  const line = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/** The id `studio launch run` printed (`launch <id>: bundle at …`). */
export function launchIdFromOutput(stdout) {
  return stdout.match(/^launch (\S+): bundle at /m)?.[1] ?? null;
}
