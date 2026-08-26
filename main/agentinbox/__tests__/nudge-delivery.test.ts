import { describe, expect, it } from 'vitest';
import { deliverNudge, type NudgeIO } from '../nudge-delivery';
import { PASTE_END, PASTE_START } from '../../terminal/keystrokes';

/**
 * DID THE NOTICE ACTUALLY GET TYPED?
 *
 * The owner's report: *"I just got the notice that a message was incoming but it
 * never ever came and I hit enter like it said but nothing happened. my cursor
 * was in the input, but nothing was typed."*
 *
 * Half of that is the toast pointing at the wrong terminal (see
 * attention/inbox-incoming-notice). The other half is this: the toast was raised
 * from the fact that `append` was ATTEMPTED, never from the fact that it
 * SUCCEEDED. `writeToTerminal` returns a boolean — false when the backend has no
 * pty for that id — and the delivery loop dropped it on the floor, so a nudge to
 * a terminal whose pty had exited wrote nothing and announced it anyway.
 *
 * That is reachable, not theoretical: the AgentInbox keeps an agent registered
 * when its pty exits and its spec is retained (`broker.away`), and neither the
 * notify path nor the input hold checks liveness. A DM to such an agent produced
 * exactly the reported symptom.
 *
 * A one-line `catch {}` that claimed success is the same bug in the other
 * direction, so a throw mid-sequence is covered too.
 */

function io(overrides: Partial<NudgeIO> = {}) {
    const writes: { id: string; bytes: string }[] = [];
    const announced: { id: string; landed: boolean }[] = [];
    const released: string[] = [];
    const base: NudgeIO = {
        write: (id, bytes) => {
            writes.push({ id, bytes });
            return true;
        },
        releaseHold: (id) => {
            released.push(id);
            return '';
        },
        announce: (id, landed) => announced.push({ id, landed }),
        sleep: async () => {},
        ...overrides,
    };
    return { io: base, writes, announced, released };
}

const NOTICE = '[Genie] You just received a message from tynn:lead as a DM.';

describe('deliverNudge', () => {
    it('appends the notice and reports that it LANDED', async () => {
        const h = io();

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'append' });

        // The notice goes in as a bracketed paste so it cannot submit itself.
        expect(h.writes).toHaveLength(1);
        expect(h.writes[0]!.bytes).toBe(`${PASTE_START}${NOTICE}${PASTE_END}`);
        expect(h.announced).toEqual([{ id: 'term-7', landed: true }]);
    });

    it('reports NOT landed when the pty write fails — the reported bug', async () => {
        const h = io({ write: () => false });

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'append' });

        // POSITIVE CONTROL: the toast must still be raised (the message DID
        // arrive), so a delivery that announced nothing at all cannot pass this.
        expect(h.announced).toHaveLength(1);
        expect(h.announced[0]).toEqual({ id: 'term-7', landed: false });
    });

    it('reports NOT landed when a write throws', async () => {
        const h = io({
            write: () => {
                throw new Error('backend gone');
            },
        });

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'append' });

        expect(h.announced).toEqual([{ id: 'term-7', landed: false }]);
    });

    it('reports NOT landed when ANY write in the sequence fails', async () => {
        // Not reachable for `append` (one write), but the flag must mean what it
        // says for every plan, or the next mode to grow a toast inherits the bug.
        let n = 0;
        const attempted: string[] = [];
        const h = io({
            write: (_id, bytes) => {
                attempted.push(bytes);
                return ++n !== 2;
            },
        });

        const landed = await deliverNudge(h.io, 'term-7', NOTICE, {
            mode: 'swap',
            restore: 'half a sentence',
        });

        expect(landed).toBe(false);
        // The rest of the sequence is still attempted — by the time a write
        // fails the pty is gone, and stopping half way through a swap would be
        // its own kind of mess.
        expect(attempted.length).toBeGreaterThan(2);
    });

    it('gives the keyboard back even when every write fails', async () => {
        // Those bytes were taken from the person; they come back regardless.
        const replayed: string[] = [];
        const h = io({
            write: (_id, bytes) => {
                replayed.push(bytes);
                return false;
            },
            releaseHold: () => 'typed while held',
        });

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'append' });

        expect(replayed).toContain('typed while held');
    });

    it('gives the keyboard back even when a write throws', async () => {
        const h = io({
            write: () => {
                throw new Error('backend gone');
            },
            releaseHold: (id) => {
                h.released.push(id);
                return '';
            },
        });

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'append' });

        expect(h.released).toContain('term-7');
    });

    it('does NOT announce for a plan that submits — there is nothing sitting unsent', async () => {
        const h = io();

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'submit' });

        expect(h.announced).toEqual([]);
        // …but it did do the work, so this is not passing on a no-op.
        expect(h.writes.length).toBeGreaterThan(0);
    });

    it('does NOT announce for a swap — the notice was submitted and the draft restored', async () => {
        const h = io();

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'swap', restore: 'my draft' });

        expect(h.announced).toEqual([]);
        expect(h.writes.length).toBeGreaterThan(0);
    });

    it('waits out the settle gap between writes, so an Enter is its own chunk', async () => {
        const slept: number[] = [];
        const h = io({ sleep: async (ms) => void slept.push(ms) });

        await deliverNudge(h.io, 'term-7', NOTICE, { mode: 'submit' });

        expect(slept.filter((ms) => ms > 0).length).toBeGreaterThan(0);
    });

    it('returns whether the notice landed, so a caller can react', async () => {
        const ok = await deliverNudge(io().io, 'term-7', NOTICE, { mode: 'append' });
        const bad = await deliverNudge(io({ write: () => false }).io, 'term-7', NOTICE, {
            mode: 'append',
        });

        expect(ok).toBe(true);
        expect(bad).toBe(false);
    });
});
