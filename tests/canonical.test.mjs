import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentSha256 } from '../scripts/canonical.mjs';

const vector = JSON.parse(readFileSync('tests/vector.json', 'utf8'));
const fixture = JSON.parse(readFileSync('fixtures/example-widget.json', 'utf8'));

describe('canonical digest (plan D1)', () => {
  it('matches the vector computed by the web recipe in Python, astral keys and non-ASCII included', () => {
    expect(contentSha256(vector.value)).toBe(vector.sha256);
  });
  it('matches the fixture snapshot', () => {
    expect(contentSha256(fixture.snapshot.document)).toBe(fixture.snapshot.content_sha256);
  });
  it('emits no insignificant whitespace and sorts keys', () => {
    expect(canonicalJson({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });
  it('refuses a float, which it does not reproduce', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/non-integer/);
  });
});
