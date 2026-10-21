import { describe, expect, it } from 'vitest';
import { AGENT_SCOPED_METHODS, capabilityOf, inMemoryPair, parseMessage, REMOTE_METHODS, remoteBadge, WORKSPACE_SCOPED_METHODS, type WireMessage } from '../src/core/remote-protocol.js';

/**
 * THE REMOTE WIRE (§6.8) — the pure half of driving another machine's Genie. One message shape both
 * ways (hello/welcome/refused, call/result, event), parsed defensively (a bad frame is a refusal, not
 * a crash), and ONE table saying what each bridge method is: a READ (never gated on the baton), a
 * WRITE (gated), an UPGRADE (gated on ownership), or HOST-ONLY (a window or a picker on the host —
 * refused remotely with where to do it instead). Derived from the table, never a second list.
 */

describe('messages', () => {
    it('parses the three shapes and refuses anything else with a reason — never a throw', () => {
        expect(parseMessage(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token: 't' }, label: 'phone' }))).toEqual({ ok: true, message: { kind: 'hello', auth: { kind: 'token', token: 't' }, label: 'phone' } });
        expect(parseMessage(JSON.stringify({ kind: 'call', id: 7, method: 'snapshot', args: [] }))).toEqual({ ok: true, message: { kind: 'call', id: 7, method: 'snapshot', args: [] } });
        expect(parseMessage(JSON.stringify({ kind: 'event', channel: 'snapshot', payload: { agents: [] } }))).toMatchObject({ ok: true });
        expect(parseMessage('not json')).toEqual({ ok: false, reason: 'not JSON' });
        expect(parseMessage(JSON.stringify({ kind: 'dance' }))).toEqual({ ok: false, reason: 'unknown message kind "dance"' });
        expect(parseMessage(JSON.stringify({ kind: 'call', id: 'x', method: 'snapshot', args: [] }))).toEqual({ ok: false, reason: 'a call needs a numeric id, a method and an args array' });
        expect(parseMessage(JSON.stringify({ kind: 'call', id: 1, method: 'eval', args: [] }))).toEqual({ ok: false, reason: '"eval" is not a bridge method' });
    });
});

describe('the capability table', () => {
    it('every bridge method is classified exactly once; reads are never gated, upgrade is ownership, host-only names the host', () => {
        expect(capabilityOf('snapshot')).toBe('read');
        expect(capabilityOf('agentDetail')).toBe('read');
        expect(capabilityOf('terminals.list')).toBe('read');
        expect(capabilityOf('features.snapshot')).toBe('read');
        expect(capabilityOf('updates.state')).toBe('read');
        expect(capabilityOf('openAgent')).toBe('write');
        expect(capabilityOf('prompt')).toBe('write');
        expect(capabilityOf('features.act')).toBe('write');
        expect(capabilityOf('terminals.write')).toBe('write');
        expect(capabilityOf('restartWithHandoff')).toBe('write');
        // Tynn #845: the upgrade is the owner's, all of it — no baton.
        expect(capabilityOf('updates.check')).toBe('upgrade');
        expect(capabilityOf('updates.download')).toBe('upgrade');
        expect(capabilityOf('updates.install')).toBe('upgrade');
        expect(capabilityOf('addWorkspace')).toBe('host-only');
        expect(capabilityOf('takeOver')).toBe('host-only');
        expect(capabilityOf('providerLogin')).toBe('host-only');
        expect(capabilityOf('features.setBrowserBounds')).toBe('host-only');
        // COUNTED: the table covers the whole bridge surface and nothing twice.
        expect(new Set(REMOTE_METHODS).size).toBe(REMOTE_METHODS.length);
        // 46 since `inbox.sendFile` (§6.8): a phone's upload rides the socket as bytes.
        // 47 since `terminals.attach` (§6.5): a second surface JOINS a running terminal instead of opening one.
        // 49 since the Tynn source (§6.1): preview on the host, confirm as a write.
        // 50 since `workspaces.removeRepoLock` (the board's "Remove stale lock" on a red repo chip): a write, workspace-scoped.
        // 51 since `workspaces.locateRepo` (the board's "Locate repo" on a Dashboard group fault): host-only — the picker is the host's.
        // 52 since `workspaces.commitsSince` (an observed agent's index): a read, workspace-scoped.
        // 51 since `updates.cancel` left with the upgrade drain (no agent is asked for a handoff any more).
        // 52 since `agents.setPermissions` (a Claude agent's tools, chosen on its Agent view): a write, agent-scoped.
        // 53 since `agents.setModel` (an agent's model, chosen on its Agent view): a write, agent-scoped.
        // 54 since `cancelTurn` (`Stop this turn` — the current turn ends, the agent keeps running): a write, agent-scoped.
        // 55 since `resumeLimit` (`Resume now` while a provider's login is held for its rate limit, Tynn #794): a write, agent-scoped.
        // 56 since `agents.setAutoApprove` (an agent's autonomy, Tynn #801): a write, agent-scoped.
        // 57 since `agents.setIssueWatch` (what an agent hears from IssueWatch, Tynn #806): a write, agent-scoped.
        // 58 since `providerLogin` (Log in to <provider>, 2026-10-18): host-only like takeOver — it opens a window on the host.
        // 59 since `workspaces.tynnProjects` (From Tynn picks from the signed-in person's projects, 2026-10-19): host-only
        // like the preview it leads to — the folder picker after it is the host's.
        // 60 since `workspaces.setDefaultAgent` (Genie 1's default agent, 2026-10-19): a write, workspace-scoped like setGoverns.
        // 61 since `host.listDir` (Tynn #835: every file and folder picker reads the HOST's disk): a read; a guest only inside its workspace(s).
        // 62 since `workspaces.create` (Genie 1's New workspace, 2026-10-21): a write — Genie makes the folder on the host.
        // 63 since `agents.setManageTabs` (May manage workspace tabs, beta.35 item 36): a write, agent-scoped.
        // 64 since `activity` (beta.33 item 10: the Dashboard's lanes read every agent's activity feed): a read, workspace-scoped.
        // 65 since `agents.setDrivePages` (May drive pages, browser rebuild step 7): a write, agent-scoped.
        expect(REMOTE_METHODS.length).toBe(65);
        expect(capabilityOf('agents.setDrivePages')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setDrivePages');
        expect(capabilityOf('activity')).toBe('read');
        expect(WORKSPACE_SCOPED_METHODS).toContain('activity');
        expect(capabilityOf('agents.setManageTabs')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setManageTabs');
        expect(capabilityOf('workspaces.setDefaultAgent')).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.setDefaultAgent');
        // Tynn #835: the parent folder is picked IN THE WINDOW over the host's disk, so these are reads now (owner-only:
        // they add to the host itself), and Locate repo is a write in its workspace.
        expect(capabilityOf('workspaces.tynnProjects')).toBe('read');
        expect(capabilityOf('cancelTurn')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('cancelTurn');
        expect(capabilityOf('workspaces.commitsSince')).toBe('read');
        expect(capabilityOf('workspaces.locateRepo')).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.locateRepo');
        expect(capabilityOf('workspaces.previewAddFromGit')).toBe('read');
        expect(capabilityOf('workspaces.removeRepoLock')).toBe('write');
        expect(capabilityOf('workspaces.previewAddFromTynn')).toBe('read');
        expect(capabilityOf('workspaces.confirmAddFromTynn')).toBe('write');
        expect(capabilityOf('inbox.sendFile')).toBe('write');
        // Tynn #835: the folder is picked in the window (FileBrowser over the host's own disk), so the preview reads a path.
        expect(capabilityOf('workspaces.previewAdd')).toBe('read');
        expect(capabilityOf('host.listDir')).toBe('read');
        expect(capabilityOf('workspaces.hibernate')).toBe('write');
        expect(capabilityOf('agents.restart')).toBe('write');
        expect(capabilityOf('agents.diagnose')).toBe('read');
        expect(capabilityOf('agents.previewDelete')).toBe('read');
    });
});

describe('the badge and the pair', () => {
    it('the REMOTE badge is loud and names the host', () => {
        expect(remoteBadge('studio')).toBe('● REMOTE — studio');
    });

    it('an in-memory pair delivers each side’s frames to the other, in order, and a close reaches the peer once', async () => {
        const { client, server } = inMemoryPair();
        const got: WireMessage[] = [];
        server.onMessage((text) => { const r = parseMessage(text); if (r.ok) got.push(r.message); });
        client.send(JSON.stringify({ kind: 'call', id: 1, method: 'snapshot', args: [] }));
        client.send(JSON.stringify({ kind: 'call', id: 2, method: 'snapshot', args: [] }));
        await Promise.resolve();
        expect(got.map((m) => (m.kind === 'call' ? m.id : -1))).toEqual([1, 2]);
        let closes = 0;
        server.onClose(() => { closes += 1; });
        client.close();
        client.close();
        await Promise.resolve();
        expect(closes).toBe(1);
    });
});
