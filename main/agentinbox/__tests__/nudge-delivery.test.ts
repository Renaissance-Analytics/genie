import { describe, expect, it } from 'vitest';
import { deliverNudge, type NudgeIO } from '../nudge-delivery';

function harness(overrides: Partial<NudgeIO> = {}) {
    const writes: string[] = [];
    const released: string[] = [];
    const io: NudgeIO = {
        write: (_id, bytes) => { writes.push(bytes); return true; },
        releaseHold: (id) => { released.push(id); return ''; },
        sleep: async () => {},
        ...overrides,
    };
    return { io, writes, released };
}

const NOTICE = '[Genie] You just received a message.';

describe('deliverNudge', () => {
    it('writes and submits only an approved nudge', async () => {
        const h = harness();
        expect(await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'submit' })).toBe(true);
        expect(h.writes).toEqual([NOTICE, '\r']);
    });

    it('a deferred nudge performs no PTY write', async () => {
        const h = harness();
        expect(await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'defer' })).toBe(true);
        expect(h.writes).toEqual([]);
    });

    it('reports a failed write and always releases the keyboard hold', async () => {
        const h = harness({ write: () => false });
        expect(await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'submit' })).toBe(false);
        expect(h.released).toEqual(['term-7']);
    });

    it('contains thrown writes and still releases the hold', async () => {
        const h = harness({ write: () => { throw new Error('gone'); } });
        await expect(deliverNudge(h.io, 'term-7', NOTICE, { mode: 'submit' })).resolves.toBe(false);
        expect(h.released).toEqual(['term-7']);
    });
});
