// exhibits.yaml edits (plan D2, AI2, B6): `hub publish` appends a slug that is
// not listed, `hub unpublish` removes it. The file is edited as text so its
// comments survive, and the result is re-parsed before it is written.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { HubError } from './roots.mjs';

export const EXHIBITS = 'exhibits.yaml';

function parse(text) {
  const doc = load(text) ?? {};
  const list = doc.exhibits ?? [];
  if (!Array.isArray(list)) throw new HubError('failed', 'exhibits.yaml: `exhibits` is not a list');
  return list;
}

export const listed = (text, slug) => parse(text).some((e) => e?.slug === slug);

/** Append `- slug: <slug>`; unchanged text when already listed. */
export function addExhibit(text, slug) {
  if (listed(text, slug)) return text;
  const lines = text.replace(/\n*$/, '').split('\n');
  const start = lines.findIndex((l) => /^exhibits:\s*(\[\s*\])?\s*(#.*)?$/.test(l));
  let out;
  if (start === -1) {
    out = `${lines.join('\n')}\nexhibits:\n  - slug: ${slug}\n`;
  } else {
    lines[start] = 'exhibits:';
    // The list ends at the first later line that is neither indented, blank nor a comment.
    let end = start + 1;
    while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === '' || lines[end].startsWith('#'))) end += 1;
    while (end > start + 1 && (lines[end - 1] === '' || lines[end - 1].startsWith('#'))) end -= 1;
    lines.splice(end, 0, `  - slug: ${slug}`);
    out = `${lines.join('\n')}\n`;
  }
  if (!listed(out, slug)) throw new HubError('failed', `could not add ${slug} to exhibits.yaml`);
  return out;
}

/** Remove the `- slug: <slug>` entry and its indented fields; unchanged when absent. */
export function removeExhibit(text, slug) {
  if (!listed(text, slug)) return text;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^(\\s*)- slug:\\s*["']?${slug.replace(/[-]/g, '\\-')}["']?\\s*(#.*)?$`).test(l));
  if (at === -1) throw new HubError('failed', `exhibits.yaml lists ${slug} in a form this command does not edit; remove it by hand`);
  const indent = lines[at].match(/^(\s*)/)[1].length;
  let end = at + 1;
  while (end < lines.length && lines[end].trim() !== '' && lines[end].match(/^(\s*)/)[1].length > indent && !/^\s*- /.test(lines[end].slice(indent))) end += 1;
  lines.splice(at, end - at);
  const out = lines.join('\n');
  if (listed(out, slug)) throw new HubError('failed', `could not remove ${slug} from exhibits.yaml`);
  parse(out);
  return out;
}

/** Apply `edit` to `<dir>/exhibits.yaml`; returns whether the file changed. */
export function editExhibits(dir, edit) {
  const path = join(dir, EXHIBITS);
  const before = readFileSync(path, 'utf8');
  const after = edit(before);
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}
