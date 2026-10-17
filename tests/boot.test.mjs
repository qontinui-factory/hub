import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Plan AI4.4 (B10 restated for AD1): the live boot script carries no relay URL
// of its own, enables the relay only from the verifier's pre-load global with
// a 127.0.0.1 check, and never phones home.
describe('ui-bridge boot script', () => {
  const src = readFileSync('src/boot/ui-bridge.jsx', 'utf8');
  it('reads the relay only from window.__QONTINUI_UI_BRIDGE_RELAY__ with a 127.0.0.1 check', () => {
    expect(src).toContain('window.__QONTINUI_UI_BRIDGE_RELAY__');
    expect(src).toMatch(/hostname === '127\.0\.0\.1'/);
    expect(src).toContain('disablePhoneHome');
    expect(src).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
  });
  // The bundled library carries loopback strings and a relative default relay
  // path of its own (error hints, a URL-parsing base, the runner phone-home
  // it is told to disable, a listener default that never mounts without the
  // verifier's global). So the built check is narrower: no site origin, and
  // the opt-in global is what gates the listener. The behavioural check (a
  // plain page load makes no relay request) is the Phase 3 live acceptance.
  it.runIf(existsSync('public/_hub/ui-bridge.js'))('the built bundle hard-codes no relay endpoint of ours', () => {
    const built = readFileSync('public/_hub/ui-bridge.js', 'utf8');
    expect(built).not.toContain('build.qontinui.io');
    expect(built).toContain('__QONTINUI_UI_BRIDGE_RELAY__');
  });
});
