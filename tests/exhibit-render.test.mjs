import { readFileSync } from 'node:fs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
import Exhibit from '../src/components/Exhibit.astro';

// Phase 4 acceptance, on the rendered card: an unknowns[] entry is a dimmed
// station marked "not recorded", the featured exhibit is marked, and an
// exhibit with no committed bundle (Portofino) links to no /<slug>/ page.
const fixture = JSON.parse(readFileSync('fixtures/example-widget.json', 'utf8'));

async function render(extra) {
  const container = await AstroContainer.create();
  const exhibit = { slug: 'example-widget', ...fixture.snapshot, ...extra };
  return container.renderToString(Exhibit, { props: { exhibit } });
}

describe('the exhibit card', () => {
  it('shows each unknowns[] entry as a not-recorded station', async () => {
    const unknowns = ['product.repos: excluded_not_known_public', 'sessions.count: census_provisional'];
    const html = await render({ document: { ...fixture.snapshot.document, unknowns }, has_bundle: false });
    const rows = html.match(/<li class="gap"[^>]*>.*?<\/li>/gs) ?? [];
    expect(rows).toHaveLength(unknowns.length);
    for (const row of rows) expect(row).toContain('>not recorded</span>');
    expect(rows[0]).toMatch(/<code[^>]*>product.repos<\/code>/);
    expect(rows[0]).toContain(' — excluded not known public');
    // The two spans are separated, so the row's text reads "… not recorded".
    expect(rows[0]).toMatch(/<\/span> <span class="stamps not-recorded"/);
  });

  it('marks the featured exhibit and links to no bundle it does not have', async () => {
    const html = await render({ featured: true, has_bundle: false });
    expect(html).toMatch(/<article class="exhibit featured"/);
    expect(html).toContain('>Featured</span>');
    expect(html).not.toContain('href="/example-widget/');
  });

  it('leaves an ordinary exhibit unmarked, and links to a bundle it has', async () => {
    const html = await render({ featured: false, has_bundle: true });
    expect(html).toMatch(/<article class="exhibit"/);
    expect(html).not.toContain('>Featured</span>');
    expect(html).toContain('href="/example-widget/"');
  });
});
