import React from 'react';
import { createRoot } from 'react-dom/client';
import { UIBridgeProvider, AutoRegisterProvider, CommandRelayListener } from '@qontinui/ui-bridge/react';

// Relay only when a verifier set a loopback relay before page load.
function relayBase() {
  const raw = window.__QONTINUI_UI_BRIDGE_RELAY__;
  if (typeof raw !== 'string') return null;
  try { const u = new URL(raw); return u.protocol === 'http:' && u.hostname === '127.0.0.1' ? u.href.replace(/\/$/, '') : null; } catch { return null; }
}
const base = relayBase();
const sessionId = crypto.randomUUID();
function Boot() {
  return (
    <UIBridgeProvider>
      <AutoRegisterProvider enabled={true} mediaDiscovery={true}>
        {base ? <CommandRelayListener enabled basePath={base} disablePhoneHome
            registrationMetadata={() => ({ userId: 'hub-verifier', sessionId })} /> : null}
      </AutoRegisterProvider>
    </UIBridgeProvider>
  );
}
const host = document.createElement('div'); host.id = '__hub_ui_bridge'; document.body.appendChild(host);
createRoot(host).render(<Boot />);
