import { describe, it, expect, vi } from 'vitest';
import { RelayFrameMux } from '../relay-mux';
import type { Frame } from '../relay-protocol';

/** A mux wired to a frame-capturing sink (no socket). */
function makeMux() {
    const sent: Frame[] = [];
    const mux = new RelayFrameMux('sid-1', (f) => sent.push(f));
    return { mux, sent };
}

describe('RelayFrameMux — REST', () => {
    it('sends an open `rest` frame with a reqId + payload, and resolves on the reply', async () => {
        const { mux, sent } = makeMux();
        const p = mux.rest({ method: 'GET', path: '/api/state', workspaceId: 'w1' });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            kind: 'open',
            channel: 'rest',
            sid: 'sid-1',
            payload: { method: 'GET', path: '/api/state', workspaceId: 'w1' },
        });
        const reqId = sent[0].reqId!;
        mux.handle({ kind: 'data', channel: 'rest', sid: 'sid-1', reqId, payload: { status: 200, body: '{}' } });
        await expect(p).resolves.toEqual({ status: 200, body: '{}' });
    });

    it('correlates concurrent requests by reqId', async () => {
        const { mux, sent } = makeMux();
        const a = mux.rest({ method: 'GET', path: '/a' });
        const b = mux.rest({ method: 'GET', path: '/b' });
        const [idA, idB] = [sent[0].reqId!, sent[1].reqId!];
        expect(idA).not.toBe(idB);
        // Reply to B first.
        mux.handle({ kind: 'data', channel: 'rest', sid: 'sid-1', reqId: idB, payload: { status: 201 } });
        mux.handle({ kind: 'data', channel: 'rest', sid: 'sid-1', reqId: idA, payload: { status: 200 } });
        await expect(a).resolves.toEqual({ status: 200 });
        await expect(b).resolves.toEqual({ status: 201 });
    });

    it('rejects on an error reply, and ignores an unknown reqId', async () => {
        const { mux } = makeMux();
        const p = mux.rest({ method: 'POST', path: '/x' });
        mux.handle({ kind: 'data', channel: 'rest', sid: 'sid-1', reqId: 'bogus', payload: {} }); // ignored
        mux.handle({ kind: 'error', channel: 'rest', sid: 'sid-1', reqId: 'r1', reason: 'scope denied' });
        await expect(p).rejects.toThrow(/scope denied/);
    });
});

describe('RelayFrameMux — events + term', () => {
    it('opens events, routes pushed data, and closes', () => {
        const { mux, sent } = makeMux();
        const got: string[] = [];
        const close = mux.openEvents((m) => got.push(m));
        expect(sent[0]).toMatchObject({ kind: 'open', channel: 'events', sid: 'sid-1', payload: { path: '/ws/events' } });
        mux.handle({ kind: 'data', channel: 'events', sid: 'sid-1', payload: '{"type":"x"}' });
        expect(got).toEqual(['{"type":"x"}']);
        close();
        expect(sent[1]).toMatchObject({ kind: 'close', channel: 'events', sid: 'sid-1' });
        // After close, further data is dropped.
        mux.handle({ kind: 'data', channel: 'events', sid: 'sid-1', payload: 'late' });
        expect(got).toEqual(['{"type":"x"}']);
    });

    it('opens a term stream by terminal id, pipes data both ways, and closes', () => {
        const { mux, sent } = makeMux();
        const out: string[] = [];
        const term = mux.openTerm('term-7', (m) => out.push(m));
        expect(sent[0]).toMatchObject({
            kind: 'open',
            channel: 'term',
            sid: 'sid-1',
            payload: { path: '/ws/term?terminal=term-7' },
        });
        // No workspaceId passed → the open frame omits it (fails closed to
        // host:all on the host side; wire-compatible with old clients).
        expect((sent[0].payload as Record<string, unknown>).workspaceId).toBeUndefined();
        mux.handle({ kind: 'data', channel: 'term', sid: 'sid-1', payload: 'hello\r\n' });
        expect(out).toEqual(['hello\r\n']);
        term.send('ls\n');
        expect(sent[1]).toMatchObject({ kind: 'data', channel: 'term', sid: 'sid-1', payload: 'ls\n' });
        term.close();
        expect(sent[2]).toMatchObject({ kind: 'close', channel: 'term', sid: 'sid-1' });
    });

    it('tags the workspaceId onto the term open frame when provided', () => {
        const { mux, sent } = makeMux();
        const term = mux.openTerm('term-7', () => {}, 'ws-42');
        expect(sent[0]).toMatchObject({
            kind: 'open',
            channel: 'term',
            sid: 'sid-1',
            payload: { path: '/ws/term?terminal=term-7', workspaceId: 'ws-42' },
        });
        term.close();
    });
});

describe('RelayFrameMux — link drop', () => {
    it('rejectAll fails every in-flight REST request', async () => {
        const { mux } = makeMux();
        const p = mux.rest({ method: 'GET', path: '/api/state' });
        mux.rejectAll('relay connection closed');
        await expect(p).rejects.toThrow(/relay connection closed/);
    });
});
