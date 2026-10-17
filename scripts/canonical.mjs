// The content digest qontinui-web computes for a published build record
// (backend/app/api/v1/endpoints/build_records.py:175):
//   json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
// encoded as UTF-8, then sha256. Plan D1: the hub recomputes it rather than
// trusting the snapshot's own `content_sha256` field.
import { createHash } from 'node:crypto';

// Python sorts dict keys by code point; JavaScript's default sort compares
// UTF-16 code units, which disagree for astral characters.
function byCodePoint(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      // The allowlisted record carries integers only; a float would need
      // Python's repr rules, which this function does not reproduce.
      throw new Error(`non-integer number in a build record: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort(byCodePoint);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function contentSha256(document) {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}
