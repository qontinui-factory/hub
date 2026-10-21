// Git in the ONE hub clone (plan A3). Nothing here stashes or cleans: a dirty
// tree outside `public/<slug>/` is refused, never tidied.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HubError } from './roots.mjs';

export function makeGit(cwd, { run = execFileSync } = {}) {
  const git = (args, opts = {}) =>
    run('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...opts,
    });
  const ok = (args) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  const self = {
    raw: git,
    /** Paths `git status --porcelain` reports (untracked included, gitignored not). */
    dirtyPaths() {
      const entries = git(['status', '--porcelain', '--untracked-files=all', '-z']).split('\0');
      const out = [];
      for (let i = 0; i < entries.length; i += 1) {
        const e = entries[i];
        if (!e) continue;
        out.push(e.slice(3));
        // A rename or copy carries its source path as the next NUL field.
        if (e[0] === 'R' || e[0] === 'C') out.push(entries[(i += 1)]);
      }
      return [...new Set(out.filter(Boolean))];
    },
    /** Untracked, not ignored, files under `path`. */
    untracked: (path) => git(['ls-files', '--others', '--exclude-standard', '-z', '--', path]).split('\0').filter(Boolean),
    fetch() {
      git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    },
    /** Fetch a PR's head into a local ref and return its commit. */
    fetchPr(number) {
      const ref = `refs/hub/pr/${number}`;
      git(['fetch', '--quiet', 'origin', `+refs/pull/${number}/head:${ref}`]);
      return git(['rev-parse', ref]).trim();
    },
    head: () => git(['rev-parse', 'HEAD']).trim(),
    mainSha: () => git(['rev-parse', 'refs/remotes/origin/main']).trim(),
    checkoutDetached(commit) {
      git(['checkout', '--quiet', '--detach', commit]);
    },
    /** Point local main at origin/main and check it out, discarding tracked changes. */
    resetToMain() {
      git(['checkout', '--quiet', '-B', 'main', 'refs/remotes/origin/main']);
      git(['reset', '--quiet', '--hard', 'refs/remotes/origin/main']);
    },
    /** Cut `name` at HEAD (resetting a stale local branch of the same name). */
    newBranch(name) {
      git(['checkout', '--quiet', '-B', name]);
    },
    /** The tree id of `path` at `commit`, or null when it is absent there. */
    treeAt(commit, path) {
      try {
        return git(['rev-parse', '--verify', '--quiet', `${commit}:${path}`]).trim() || null;
      } catch {
        return null;
      }
    },
    isAncestor: (a, b) => ok(['merge-base', '--is-ancestor', a, b]),
    /** Stage exactly `paths` (additions, changes and deletions) and commit; null when nothing changed. */
    commitPaths(paths, message) {
      // A path that is neither on disk nor tracked has nothing to stage (and
      // `git add` would refuse the pathspec).
      const present = paths.filter((p) => existsSync(join(cwd, p)) || git(['ls-files', '--', p]).trim());
      if (present.length) git(['add', '-A', '--', ...present]);
      const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      if (!staged.length) return null;
      const outside = staged.filter((p) => !paths.some((q) => p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`)));
      if (outside.length) throw new HubError('failed', `refusing to commit paths outside ${paths.join(', ')}: ${outside.join(', ')}`);
      git(['commit', '--quiet', '-m', message]);
      return self.head();
    },
    gitDir: () => git(['rev-parse', '--absolute-git-dir']).trim(),
    /** The remote branch's commit, or null when it does not exist. */
    remoteBranch(branch) {
      const out = git(['ls-remote', 'origin', `refs/heads/${branch}`]).trim();
      return out ? out.split(/\s+/)[0] : null;
    },
    /**
     * Push exactly `oid` (what commitPaths returned) to `branch`. A branch
     * that already exists on origin (an AF2 re-issue reuses
     * `unpublish/<slug>-<launch-id>`; its closed PR keeps refs/pull/<n>/head)
     * is replaced only under a lease on the value just read.
     */
    push(branch, oid) {
      const existing = self.remoteBranch(branch);
      const lease = existing ? [`--force-with-lease=refs/heads/${branch}:${existing}`] : [];
      git(['push', '--quiet', ...lease, 'origin', `${oid}:refs/heads/${branch}`]);
    },
    /**
     * The `path` tree id at each commit on origin/main that touched it since
     * `sinceIso` (newest first, at most `max`); null where the path is absent.
     */
    pathHistory(path, sinceIso, max = 200) {
      const commits = git(['log', `--max-count=${max}`, `--since=${sinceIso}`, '--format=%H', 'refs/remotes/origin/main', '--', path])
        .split('\n')
        .filter(Boolean);
      return commits.map((c) => self.treeAt(c, path));
    },
  };
  return self;
}

/** A3: refuse anything dirty outside `public/<slug>/` (gitignored files never show). */
export function assertCleanOutsideSlug(git, slug) {
  const prefix = `public/${slug}/`;
  const outside = git.dirtyPaths().filter((p) => !p.startsWith(prefix));
  if (outside.length) {
    throw new HubError(
      'refused',
      `the hub clone is dirty outside ${prefix}: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ', …' : ''} (A3: never stashed or cleaned; resolve it by hand)`,
    );
  }
}
