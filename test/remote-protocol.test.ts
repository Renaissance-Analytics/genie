import { describe, expect, it } from 'vitest';
import { capabilityOf, inMemoryPair, parseMessage, REMOTE_METHODS, remoteBadge, type WireMessage } from '../src/core/remote-protocol.js';

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
        expect(capabilityOf('updates.download')).toBe('write');
        expect(capabilityOf('updates.install')).toBe('upgrade');
        expect(capabilityOf('addWorkspace')).toBe('host-only');
        expect(capabilityOf('takeOver')).toBe('host-only');
        expect(capabilityOf('features.setBrowserBounds')).toBe('host-only');
        // COUNTED: the table covers the whole bridge surface and nothing twice.
        expect(new Set(REMOTE_METHODS).size).toBe(REMOTE_METHODS.length);
        // 34 since `updates.cancel` (§7.5): a drain can be abandoned from a remote window too.
        expect(REMOTE_METHODS.length).toBe(43);
        expect(capabilityOf('workspaces.previewAdd')).toBe('host-only');
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
