import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collect, guard, hasBundle, verify } from '../scripts/fetch-exhibits.mjs';

const fixture = JSON.parse(readFileSync('fixtures/example-widget.json', 'utf8'));

function stubFetch(map) {
  return async (url) => {
    const slug = decodeURIComponent(url.split('/').pop());
    const hit = map[slug];
    if (!hit) return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => hit };
  };
}

describe('exhibit reads (plan D1, A1, AI4.5)', () => {
  it('fails the build on a tampered document', () => {
    const tampered = structuredClone(fixture.snapshot);
    tampered.document.wall_clock_secs += 1;
    expect(() => verify('example-widget', tampered)).toThrow(/content_sha256 mismatch/);
  });

  it('drops a 404 exhibit when no bundle is committed', async () => {
    const shown = await collect([{ slug: 'gone' }], { fetchImpl: stubFetch({}), bundleExists: false });
    expect(shown).toEqual([]);
  });

  it('shows a verified live snapshot', async () => {
    const shown = await collect([{ slug: 'example-widget' }], {
      fetchImpl: stubFetch({ 'example-widget': fixture.snapshot }),
    });
    expect(shown.map((e) => e.slug)).toEqual(['example-widget']);
  });

  it('marks an exhibit with a committed launch bundle, so the gallery links to it', async () => {
    const opts = { fetchImpl: stubFetch({ 'example-widget': fixture.snapshot }) };
    const entry = [{ slug: 'example-widget' }];
    expect((await collect(entry, { ...opts, bundleExists: true }))[0].has_bundle).toBe(true);
    expect((await collect(entry, { ...opts, bundleExists: false }))[0].has_bundle).toBe(false);
  });

  it('counts a bundle only when both linked pages are there', () => {
    const publicRoot = mkdtempSync(join(tmpdir(), 'hub-bundle-'));
    try {
      const dir = join(publicRoot, 'probe');
      expect(hasBundle('probe', { publicRoot })).toBe(false);
      mkdirSync(dir);
      writeFileSync(join(dir, 'index.html'), '');
      expect(hasBundle('probe', { publicRoot })).toBe(false);
      writeFileSync(join(dir, 'how-it-was-built.html'), '');
      expect(hasBundle('probe', { publicRoot })).toBe(true);
    } finally {
      rmSync(publicRoot, { recursive: true, force: true });
    }
  });

  it('A1 guard: a committed bundle with a retracted record fails the deploy build', () => {
    expect(() => guard('gone', { guardMode: 'deploy', touched: new Set(), bundleExists: true })).toThrow(/A1 guard/);
  });

  it('A1 guard in PR CI: warns unless the PR touched that bundle', () => {
    expect(guard('gone', { guardMode: 'pr', touched: new Set(), bundleExists: true })).toBe('warn');
    expect(() => guard('gone', { guardMode: 'pr', touched: new Set(['gone']), bundleExists: true })).toThrow(/A1 guard/);
  });
});
