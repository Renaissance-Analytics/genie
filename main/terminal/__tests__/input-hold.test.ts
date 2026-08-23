import { describe, expect, it } from 'vitest';
import { InputHolds, HOLD_MAX_BYTES, HOLD_MAX_MS } from '../input-hold';

/**
 * Holding the human's keystrokes while Genie swaps their draft out of the input
 * box (owner, JOB 2 — "buffer the keystrokes, replay after restore").
 *
 * The swap is several pty writes with a settle delay between them, so it spans
 * ~100–300ms. A keystroke landing in the middle would be captured into the cut,
 * interleaved with the nudge, or lost outright. So the writes are held and
 * replayed once the draft is back.
 *
 * The failure that must NEVER happen is a hold that outlives its swap and
 * silently eats someone's typing. Every limit here therefore fails OPEN — it
 * stops holding and lets the keystrokes through — because a slightly messy swap
 * is recoverable and a dead keyboard is not.
 */
const T = 't-agent';
const NOW = 1_000_000;

describe('InputHolds — the basic hold/replay cycle', () => {
    it('passes keystrokes straight through when no swap is running', () => {
        const h = new InputHolds();
        expect(h.hold(T, 'abc', NOW)).toBe(false);
        expect(h.isHeld(T)).toBe(false);
    });

    it('buffers keystrokes during a swap and replays them in order', () => {
        const h = new InputHolds();
        expect(h.begin(T, NOW)).toBe(true);
        expect(h.hold(T, 'he', NOW + 10)).toBe(true);
        expect(h.hold(T, 'llo', NOW + 20)).toBe(true);
        expect(h.release(T)).toBe('hello');
    });

    it('a released hold stops buffering', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'x', NOW + 1);
        h.release(T);
        expect(h.isHeld(T)).toBe(false);
        expect(h.hold(T, 'y', NOW + 2)).toBe(false);
    });

    it('releasing with nothing typed replays nothing', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        expect(h.release(T)).toBe('');
    });

    it('holds are per terminal — one swap never gags another', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        expect(h.hold('t-other', 'typed elsewhere', NOW + 5)).toBe(false);
        expect(h.release(T)).toBe('');
    });

    it('releasing a terminal that was never held is a safe no-op', () => {
        const h = new InputHolds();
        expect(h.release('nobody')).toBe('');
    });
});

describe('InputHolds — refuses to nest', () => {
    it('a second begin while one is running is refused', () => {
        const h = new InputHolds();
        expect(h.begin(T, NOW)).toBe(true);
        // Two notices racing must not both swap the same box.
        expect(h.begin(T, NOW + 5)).toBe(false);
    });

    it('begin works again once the first swap released', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.release(T);
        expect(h.begin(T, NOW + 50)).toBe(true);
    });
});

describe('InputHolds — every limit fails OPEN, never swallowing keystrokes', () => {
    it('stops holding once the swap has outlived its watchdog', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        expect(h.hold(T, 'a', NOW + HOLD_MAX_MS - 1)).toBe(true);
        // Past the window the swap is presumed dead — let the person type.
        expect(h.hold(T, 'b', NOW + HOLD_MAX_MS + 1)).toBe(false);
    });

    it('a timed-out hold drops its hold entirely rather than lingering', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'a', NOW + HOLD_MAX_MS + 1);
        expect(h.isHeld(T)).toBe(false);
    });

    it('a timed-out hold still replays what it had already buffered', () => {
        // Those bytes were taken from the person; they must come back.
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'early', NOW + 1);
        h.hold(T, 'late', NOW + HOLD_MAX_MS + 1);
        expect(h.release(T)).toBe('early');
    });

    it('stops holding once the buffer is implausibly large', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        expect(h.hold(T, 'x'.repeat(HOLD_MAX_BYTES), NOW + 1)).toBe(true);
        expect(h.hold(T, 'more', NOW + 2)).toBe(false);
    });

    it('an oversized buffer is still replayed, not discarded', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'y'.repeat(HOLD_MAX_BYTES), NOW + 1);
        h.hold(T, 'overflow', NOW + 2);
        expect(h.release(T)).toBe('y'.repeat(HOLD_MAX_BYTES));
    });
});

/**
 * A hold that stops CAPTURING must still stay REGISTERED until it is released.
 *
 * Dropping the registration when a limit trips looked tidy but opened two holes
 * at once: a second notice could `begin` a swap on a terminal whose first swap
 * was still running — the exact thing `begin` exists to prevent — and that
 * second swap's release would then return its own buffer and discard the bytes
 * the first one had already taken from the person.
 */
describe('InputHolds — a stopped hold still blocks a second swap', () => {
    it('refuses a new swap even after the watchdog stopped capture', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'a', NOW + HOLD_MAX_MS + 1); // capture stops here
        expect(h.begin(T, NOW + HOLD_MAX_MS + 2)).toBe(false);
    });

    it('refuses a new swap even after the buffer cap stopped capture', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'x'.repeat(HOLD_MAX_BYTES), NOW + 1);
        h.hold(T, 'more', NOW + 2); // capture stops here
        expect(h.begin(T, NOW + 3)).toBe(false);
    });

    it('the release that ends the swap still replays everything it took', () => {
        const h = new InputHolds();
        h.begin(T, NOW);
        h.hold(T, 'taken', NOW + 1);
        h.hold(T, 'dropped', NOW + HOLD_MAX_MS + 1); // passes through to the pty
        expect(h.release(T)).toBe('taken');
        // And only now may the next swap start.
        expect(h.begin(T, NOW + HOLD_MAX_MS + 2)).toBe(true);
    });
});
