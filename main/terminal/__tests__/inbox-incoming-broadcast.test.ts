import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * THE PAYLOAD THAT REACHES THE RENDERER.
 *
 * `broadcastInboxIncoming` used to send `{ id }` and nothing else, and the
 * renderer threw even that away — it rendered a fixed string, "A message just
 * came in for **this** agent", for every terminal in every workspace. The owner
 * pressed Enter in the terminal he was looking at, which was not the addressee,
 * and nothing happened, because nothing had been typed there.
 *
 * This is the main half of that fix: whatever the renderer chooses to draw, the
 * facts it needs must be ON THE WIRE. So assert the broadcast payload names the
 * agent and the workspace, and carries the terminal + workspace ids the toast's
 * click needs to reveal it.
 *
 * The mocks mirror the sibling ipc tests (specs-changed-broadcast) so importing
 * ../ipc doesn't touch node-pty or disk; `../remote` is mocked to CAPTURE the
 * broadcast rather than fan it out to windows that don't exist here.
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

/** The spec `announceInboxIncoming` will look up, swapped per test. */
let spec: unknown = null;

vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: () => spec,
    getWorkspace: (id: string) =>
        id === 'ws-1'
            ? { id: 'ws-1', project_name: 'tynn.ai' }
            : id === '__system__'
              ? { id: '__system__', project_name: 'System', path: '/home/w/.gosa' }
              : null,
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

import { announceInboxIncoming } from '../ipc';

const agentSpec = {
    id: 'term-7',
    workspace_id: 'ws-1',
    label: 'claude · reviewer',
    meta: { agent: 'claude', whisper_purpose: 'reviewer' },
};

const incoming = () => sent.filter((s) => s.channel === 'agentinbox:incoming');

beforeEach(() => {
    sent.length = 0;
    spec = agentSpec;
});

describe('announceInboxIncoming', () => {
    it('sends the agent and workspace NAMES, not just the terminal id', () => {
        announceInboxIncoming('term-7', true);

        expect(incoming()).toHaveLength(1);
        const p = incoming()[0]!.payload as { title: string; body: string };
        const all = `${p.title} ${p.body}`;
        // POSITIVE CONTROL: an empty notice would satisfy any "does not say" test
        // below, so prove there is text at all before trusting the rest.
        expect(p.title.trim()).not.toBe('');
        expect(all).toContain('tynn.ai');
        expect(all).toContain('Claude Code');
        expect(all).toContain('reviewer');
        expect(all.toLowerCase()).not.toContain('this agent');
    });

    it('carries the ids the toast needs to REVEAL the terminal when clicked', () => {
        announceInboxIncoming('term-7', true);

        const p = incoming()[0]!.payload as { id: string; workspaceId: string | null };
        expect(p.id).toBe('term-7');
        expect(p.workspaceId).toBe('ws-1');
    });

    it('tells the renderer whether the notice actually LANDED in the prompt', () => {
        announceInboxIncoming('term-7', false);

        const p = incoming()[0]!.payload as { landed: boolean; body: string };
        expect(p.landed).toBe(false);
        expect(p.body.toLowerCase()).not.toContain('enter');
    });

    it('still announces when the spec has vanished — the message did arrive', () => {
        // A spec can be deleted between delivery and the toast. Degrade to a
        // legible notice rather than dropping the only signal the user gets.
        spec = null;
        announceInboxIncoming('term-7', true);

        expect(incoming()).toHaveLength(1);
        const p = incoming()[0]!.payload as { id: string; title: string };
        expect(p.id).toBe('term-7');
        expect(p.title.trim()).not.toBe('');
    });

    it('names the System Workspace from its own row, like any other', () => {
        // The operator's spec carries a real `workspace_id` now, so the title
        // comes off the row instead of a hard-coded literal.
        spec = { id: 'term-9', workspace_id: '__system__', label: 'system', meta: {} };
        announceInboxIncoming('term-9', true);

        const p = incoming()[0]!.payload as { workspaceId: string | null; title: string };
        expect(p.workspaceId).toBe('__system__');
        expect(p.title).toContain('System');
    });

    it('still groups an UNATTACHED System-Workspace spec under the System Workspace', () => {
        // `meta.system` survives for panels and global processes, which root at
        // their own cwd and must stay unattached. They still resolve for grouping.
        spec = { id: 'term-10', workspace_id: null, label: 'system', meta: { system: true } };
        announceInboxIncoming('term-10', true);

        const p = incoming()[0]!.payload as { workspaceId: string | null };
        expect(p.workspaceId).toBe('__system__');
    });
});
