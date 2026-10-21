// The studio host's three fixed roots (plan C1, AG2, AI1, AO1), each the
// realpath of a path under $QONTINUI_WORKSPACE_ROOT:
//   STUDIO_HUB_CLONE   = .studio/hub-publish   (the one hub clone publish_dir points into)
//   STUDIO_HUB_PREVIEW = .studio/hub-preview   (preview_dir's parent, served by `hub preview`)
//   STUDIO_ROOT        = .studio/studio-host   (the qontinui-studio clone holding the studio DB)
// An exported value that disagrees with the derived realpath is refused: the
// studio stores publish_dir as a canonical string, and `gate_foreign_file`
// matches launches on it, so two spellings of one directory would wedge it.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class HubError extends Error {
  /** kind: usage | refused | transient | auth | failed ; code: the exit code */
  constructor(kind, message, code) {
    super(message);
    this.kind = kind;
    this.code = code ?? { usage: 2, refused: 5, transient: 4, auth: 3, failed: 1 }[kind] ?? 1;
  }
}

export const ROOTS = {
  STUDIO_HUB_CLONE: '.studio/hub-publish',
  STUDIO_HUB_PREVIEW: '.studio/hub-preview',
  STUDIO_ROOT: '.studio/studio-host',
};

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Derive the roots. `create` names roots that are made when absent (the
 * preview root holds only generated files); every other root must exist.
 */
export function hubRoots(env = process.env, { need = Object.keys(ROOTS), create = ['STUDIO_HUB_PREVIEW'] } = {}) {
  const ws = env.QONTINUI_WORKSPACE_ROOT;
  if (!ws) {
    throw new HubError('usage', 'QONTINUI_WORKSPACE_ROOT is not set: the studio roots are derived from it (plan C1, AI1)');
  }
  const out = { workspace: real(ws) };
  for (const name of need) {
    const path = join(out.workspace, ROOTS[name]);
    if (!existsSync(path)) {
      if (!create.includes(name)) throw new HubError('usage', `${name}: ${path} does not exist (plan AO1 prepares it on the studio host)`);
      mkdirSync(path, { recursive: true });
    }
    const derived = realpathSync(path);
    const exported = env[name];
    if (exported !== undefined && exported !== '' && real(exported) !== derived) {
      throw new HubError('usage', `${name} is exported as ${exported}, which is not ${derived} (the realpath of <workspace>/${ROOTS[name]}); unset it or fix it`);
    }
    out[name] = derived;
  }
  return out;
}

/** publish_dir for a slug, as the studio stores it (C1: canonical, absolute). */
export const publishDir = (roots, slug) => join(roots.STUDIO_HUB_CLONE, 'public', slug);
export const previewDir = (roots, slug) => join(roots.STUDIO_HUB_PREVIEW, slug);
export const studioDb = (roots) => join(roots.STUDIO_ROOT, '.studio', 'studio.db');
