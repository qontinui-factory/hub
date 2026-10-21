// Slug checks and slug -> product yaml resolution (plan B1, A7, AI1, AI4.7).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { HubError } from './roots.mjs';

/** qontinui-studio launch/record.py SLUG_PATTERN. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** B1: hub routes and asset directories a bundle at /<slug>/ would shadow. */
export const RESERVED = ['tour', 'about', '_hub', '_astro', 'api', 'exhibits'];
/** AI4.7: the products this tenant publishes records for. */
export const OWN_PRODUCTS = ['qontinui-studio', 'qontinui-factory-hub', 'hub-retraction-probe'];

export function checkSlug(slug) {
  if (RESERVED.includes(slug)) {
    throw new HubError('refused', `slug '${slug}' is reserved: it collides with a hub route or asset directory (B1: ${RESERVED.join(', ')})`);
  }
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new HubError('usage', `not a product slug: ${JSON.stringify(slug)} (pattern ${SLUG_RE.source})`);
  }
  return slug;
}

/**
 * Resolve to exactly one of ${STUDIO_ROOT}/products/<slug>.yaml or
 * ${STUDIO_HUB_CLONE}/probe/<slug>.yaml, and check what the hub relies on:
 * the yaml's own slug, and `record.door: public` (the studio's default).
 */
export function resolveProduct(roots, slug) {
  const candidates = [join(roots.STUDIO_ROOT, 'products', `${slug}.yaml`), join(roots.STUDIO_HUB_CLONE, 'probe', `${slug}.yaml`)].filter(
    (p) => existsSync(p),
  );
  if (candidates.length === 0) {
    throw new HubError('refused', `no product yaml for '${slug}': neither ${roots.STUDIO_ROOT}/products/${slug}.yaml nor ${roots.STUDIO_HUB_CLONE}/probe/${slug}.yaml`);
  }
  if (candidates.length > 1) throw new HubError('refused', `'${slug}' resolves to two product yamls: ${candidates.join(' and ')}`);
  const path = candidates[0];
  let raw;
  try {
    raw = load(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new HubError('refused', `${path}: not readable yaml (${err.message.split('\n')[0]})`);
  }
  if (!raw || typeof raw !== 'object') throw new HubError('refused', `${path}: expected a mapping`);
  if (raw.slug !== slug) throw new HubError('refused', `${path} declares slug '${raw.slug}', not '${slug}'`);
  const door = raw.record?.door ?? 'public';
  if (door !== 'public') {
    throw new HubError('refused', `${path}: record.door is '${door}'; a page on the public hub shows only what the public route serves (A7)`);
  }
  return { path, title: raw.title, repos: raw.repos ?? [], raw };
}
