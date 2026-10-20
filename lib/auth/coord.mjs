// Coord writes the auth commands make (plan AJ1 loud failure, AK3/AL1
// reminder). They go through the session's own coord door,
// `coord-revive.sh call`, never a credential on argv. With no door, each
// write is reported as NOT made; it never fails silently.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REMINDER_PREFIX, WORK_UNIT_ID } from './config.mjs';

export function coordDoor(env = process.env) {
  if (env.HUB_COORD_REVIVE) return existsSync(env.HUB_COORD_REVIVE) ? env.HUB_COORD_REVIVE : null;
  const root = env.QONTINUI_WORKSPACE_ROOT;
  if (!root) return null;
  const p = join(root, 'qontinui-claude-config', '.claude', 'skills', 'coord-revive', 'coord-revive.sh');
  return existsSync(p) ? p : null;
}

function parseResult(out) {
  // The door prints one JSON-RPC result line; anything else is its own chatter.
  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('no JSON in the door answer');
  const decoder = JSON.parse(line);
  const text = decoder?.content?.[0]?.text;
  if (decoder?.isError) throw new Error(text ?? 'tool error');
  return text && text.trim().startsWith('{') ? JSON.parse(text) : decoder;
}

export function makeCaller(env = process.env, run = execFileSync) {
  const door = coordDoor(env);
  if (!door) return null;
  return (tool, args) =>
    // The caller's own cwd: the door resolves the nearest .mcp.json from it, so
    // the write is attributed to the session that ran the command.
    parseResult(run('bash', [door, 'call', tool, JSON.stringify(args)], { encoding: 'utf8', timeout: 120_000 }));
}

export function postAuthFinding(call, command, notDone, detail) {
  if (!call) return { posted: false, why: 'no coord door (set QONTINUI_WORKSPACE_ROOT or HUB_COORD_REVIVE)' };
  try {
    const r = call('coord_post_finding', {
      kind: 'caveat',
      topic: 'studio-publication',
      resource_keys: ['hub-auth', 'qontinui-factory/hub'],
      title: `hub ${command}: web auth failed — ${notDone}`,
      body: `${detail}\n\nRemedy: the operator re-runs \`hub auth import\` (or \`hub auth set\`). No token is quoted here.`,
    });
    // coord answers {posted: true, finding: row} or {posted: false, reason}.
    if (r.posted !== true) return { posted: false, why: r.reason ?? 'coord did not post it' };
    return { posted: true, id: r.finding?.finding_id ?? r.finding?.id ?? '(id not returned)' };
  } catch (err) {
    return { posted: false, why: err.message };
  }
}

/**
 * AK3/AL1: exactly one open reminder, timed from the newest token. The new
 * gate is registered FIRST, so a failure never leaves no reminder; the old
 * ones are then withdrawn best-effort (coord lets only the registering device
 * and agent withdraw a gate, so one from another box can refuse).
 */
export function registerReminder(call, { dueSecs, dueDate, assumed }) {
  if (!call) return { registered: false, why: 'no coord door' };
  let gateId;
  try {
    const r = call('coord_register_gate', {
      work_unit_id: WORK_UNIT_ID,
      phase_name: `${REMINDER_PREFIX} ${dueDate} — re-run hub auth import${assumed ? ' (validity assumed 30 days)' : ''}`,
      predicate: { kind: 'time_elapsed', duration_secs: dueSecs },
      clearance_audience: 'agent',
      continuation: { action: 'notify_only' },
    });
    gateId = r.gate_id;
    if (!gateId) throw new Error('coord answered with no gate_id');
  } catch (err) {
    return { registered: false, why: err.message, withdrawn: [], notWithdrawn: [] };
  }
  const withdrawn = [];
  const notWithdrawn = [];
  try {
    const list = call('coord_gate_list', { work_unit_id: WORK_UNIT_ID, open_only: true, limit: 200 });
    for (const g of list.gates ?? []) {
      // A gate row carries its phase name under `anchor`.
      const phase = g.anchor?.phase_name ?? g.phase_name ?? '';
      if (g.gate_id === gateId || !phase.startsWith(REMINDER_PREFIX)) continue;
      try {
        call('coord_withdraw_gate', { gate_id: g.gate_id, reason: `superseded by reminder ${gateId} from a newer hub auth import` });
        withdrawn.push(g.gate_id);
      } catch (err) {
        notWithdrawn.push(`${g.gate_id} (${err.message})`);
      }
    }
    if (list.truncated) notWithdrawn.push('(gate list truncated: older reminders may remain)');
  } catch (err) {
    notWithdrawn.push(`(listing failed: ${err.message})`);
  }
  return { registered: true, gateId, withdrawn, notWithdrawn };
}
