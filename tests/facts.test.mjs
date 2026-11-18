import { describe, expect, it } from 'vitest';
import { unknowns } from '../src/lib/facts.js';

describe('not-recorded stations (creative direction, Phase 4)', () => {
  it('splits each unknowns[] entry into its field and coord\'s reason, in words', () => {
    const doc = {
      unknowns: ['product.repos: excluded_not_known_public', 'timeline[].from_status: not_established', 'sessions.count'],
    };
    expect(unknowns(doc)).toEqual([
      { field: 'product.repos', reason: 'excluded not known public' },
      { field: 'timeline[].from_status', reason: 'not established' },
      { field: 'sessions.count', reason: null },
    ]);
  });

  it('has no stations when the record knows everything', () => {
    expect(unknowns({})).toEqual([]);
    expect(unknowns({ unknowns: [] })).toEqual([]);
  });
});
