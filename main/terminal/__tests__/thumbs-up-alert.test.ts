import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * An agent signalling readiness raises an alert (genie#546).
 *
 * `thumbsUp` is the green animated thumb on the agent grid — an agent saying it
 * is up and its channel works (`boot`), acknowledging a peer (`ack`), or ready
 * for Genie to stop (`shutdown`).
 *
 * ## What this alert SOUNDS LIKE, which is why it defaults to off
 *
 * Two of the three reasons are broadcast-and-answer, not one-off:
 *
 *  - `shutdown` — `AgentShutdownReadiness.begin()` sends the readiness prompt to
 *    EVERY live agent and each answers with a thumb, inside one 30s window. The
 *    upgrade drain (`agents/drain.ts`) does the same thing before an upgrade.
 *  - `boot` — every agent is told to call it after a (re)start:
 *    `agents/relaunch-prompt.ts`, `agents/upgrade-guide.ts`,
 *    `agents/os-lifecycle.ts` and the MCP guide's orientation all end there.
 *
 * So a Genie upgrade with N registered agents is N shutdown thumbs, a restart,
 * then N boot thumbs. `ack` is the only reason that is one agent doing one
 * discrete thing.
 *
 * ONE kind covers all three, per the owner's own framing of thumbsUp as one
 * signal — but it defaults to `off`, and the burst arithmetic above is why.
 * These tests pin that every reason fires the same kind, so nobody has to guess
 * which third of the setting is live.
 */

const sent: { channel: string; payload: unknown }[] = [];

vi.mock('../../remote', () => ({
    broadcastLocal: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    broadcastToAll: () => {},
    isRemoteBoundWindow: () => false,
}));

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

vi.mock('node-pty', () => ({
    spawn: () => ({ onData: () => {}, onExit: () => {}, kill: () => {} }),
}));

vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: () => null,
    getWorkspace: () => null,
    listWorkspaces: () => [],
}));

vi.mock('../genie-adapter', () => ({
    getSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    }),
    dbSettingsProvider: () => ({ get: () => undefined }),
}));

const alerts = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../../notify-sound', () => ({
    playAlert: (kind: string) => {
        alerts.played.push(kind);
        return true;
    },
}));

import { broadcastAgentThumbsUp } from '../ipc';

function thumb(reason: 'boot' | 'ack' | 'shutdown', to?: string) {
    broadcastAgentThumbsUp({
        agentId: 'a-1',
        terminalId: 't-1',
        workspaceId: 'ws-1',
        reason,
        ...(to ? { to } : {}),
    });
}

beforeEach(() => {
    sent.length = 0;
    alerts.played.length = 0;
});

describe('every reason raises the one thumbsUp alert', () => {
    it('fires on boot', () => {
        thumb('boot');
        expect(alerts.played).toEqual(['thumbsUp']);
    });

    it('fires on an agent-to-agent ack, addressed or not', () => {
        thumb('ack');
        thumb('ack', 'claude:reviewer');
        expect(alerts.played).toEqual(['thumbsUp', 'thumbsUp']);
    });

    it('fires on shutdown readiness', () => {
        thumb('shutdown');
        expect(alerts.played).toEqual(['thumbsUp']);
    });

    it('fires once PER THUMB — which is the burst, and it is not hidden', () => {
        // A drain asks every live agent and each answers. This is deliberately
        // NOT coalesced: the setting defaults to off, and someone who turns it
        // on is told in the PR exactly what a restart sounds like. Pinning the
        // per-thumb count here means a later decision to coalesce is a visible
        // change to this test rather than a silent one.
        for (let i = 0; i < 5; i++) thumb('shutdown');
        expect(alerts.played).toHaveLength(5);
    });
});

describe('the alert rides ALONGSIDE the broadcast, never instead of it', () => {
    it('still tells every window about the thumb', () => {
        // POSITIVE CONTROL for the whole file: the green thumb on the agent grid
        // is the primary signal and the chime is additive. A wiring that
        // swallowed the broadcast would pass every assertion above.
        thumb('boot');
        expect(sent.filter((s) => s.channel === 'agent:thumbs-up')).toHaveLength(1);
        expect(sent[0]?.payload).toMatchObject({
            agentId: 'a-1',
            terminalId: 't-1',
            workspaceId: 'ws-1',
            reason: 'boot',
        });
    });
});
