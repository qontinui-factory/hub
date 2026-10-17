// The counter board: numbers read straight from a build record, never
// invented. An absent value renders as "not recorded" (creative direction).
const NOT_RECORDED = null;

function hours(secs) {
  if (typeof secs !== 'number') return NOT_RECORDED;
  const h = secs / 3600;
  return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`;
}

export function counterBoard(doc) {
  const units = doc.work_units ?? [];
  const prs = doc.prs ?? [];
  const landed = prs.filter((p) => p.landed_at).length;
  const attempts = prs.every((p) => typeof p.attempts === 'number')
    ? prs.reduce((n, p) => n + p.attempts, 0)
    : NOT_RECORDED;
  return [
    { label: 'Work units shipped', value: units.filter((u) => u.status === 'shipped').length },
    { label: 'Pull requests landed', value: landed },
    { label: 'Wall-clock', value: hours(doc.wall_clock_secs) },
    { label: 'CI attempts', value: attempts },
    { label: 'Red CI fixed', value: doc.self_corrections?.red_ci_fixed ?? NOT_RECORDED },
  ];
}

// The line: one station per work unit, the PRs as parts, CI attempts as
// inspection stamps (attempts beyond the first were rework loops).
export function line(doc) {
  return (doc.prs ?? []).map((p) => ({
    label: p.title ?? `PR #${p.number}`,
    stamps: typeof p.attempts === 'number' ? p.attempts : null,
    rework: typeof p.attempts === 'number' ? Math.max(0, p.attempts - 1) : null,
    landed: Boolean(p.landed_at),
  }));
}

export function unknowns(doc) {
  return (doc.unknowns ?? []).map((u) => u.split(': ')[0]);
}
