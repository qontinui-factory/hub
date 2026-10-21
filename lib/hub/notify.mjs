// The ONE coord finding `hub publish` / `hub unpublish` posts (plan A2, B6,
// AF2): kind `status`, topic `studio-publication`, resource keys `hub:<slug>`
// and `qontinui-factory/hub#<n>`. It goes through the session's coord door
// (`makeCaller`), and a write that was not made is reported, never hidden.
import { HUB_REPO } from './prs.mjs';

export function postStatusFinding(call, { slug, pr, title, body }) {
  if (!call) return { posted: false, why: 'no coord door (set QONTINUI_WORKSPACE_ROOT or HUB_COORD_REVIVE)' };
  try {
    const r = call('coord_post_finding', {
      kind: 'status',
      topic: 'studio-publication',
      resource_keys: [`hub:${slug}`, ...(pr ? [`${HUB_REPO}#${pr}`] : [])],
      title,
      body,
    });
    if (r.posted !== true) return { posted: false, why: r.reason ?? 'coord did not post it' };
    return { posted: true, id: r.finding?.finding_id ?? r.finding?.id ?? '(id not returned)' };
  } catch (err) {
    return { posted: false, why: err.message };
  }
}

/** A loud caveat finding (topic studio-publication) for a half-done command. */
export function postCaveat(call, { slug, key, title, body }) {
  if (!call) return { posted: false, why: 'no coord door (set QONTINUI_WORKSPACE_ROOT or HUB_COORD_REVIVE)' };
  try {
    const r = call('coord_post_finding', { kind: 'caveat', topic: 'studio-publication', resource_keys: [`hub:${slug}`, key], title, body });
    if (r.posted !== true) return { posted: false, why: r.reason ?? 'coord did not post it' };
    return { posted: true, id: r.finding?.finding_id ?? r.finding?.id ?? '(id not returned)' };
  } catch (err) {
    return { posted: false, why: err.message };
  }
}
