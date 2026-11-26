import { describe, expect, it } from 'vitest';
import { nextInFlight } from '../src/renderer/toolchain-view.js';

/**
 * WHICH CARD MAIN'S ONE BUSY LINE IS DRAWN ON (Tynn #968; the toolchain row 1125-195556-df6ca9: composer installed after
 * php, and its card "showed no progress step while it installed"). The card the person clicked is marked in flight; a
 * snapshot with nothing busy that arrives BEFORE main has started the click's work (the previous install's rescan) cleared
 * the mark, so composer's busy line had no card. The mark now ends only when the work it marks has ended: busy seen, then
 * gone; or never started within a minute (a refusal, a click that ran nothing).
 */
const clicked = { card: 'composer', at: 1_000, started: false };

describe('the in-flight card', () => {
    it('a snapshot with nothing busy before the work starts keeps the mark (the race the row measured)', () => {
        expect(nextInFlight(clicked, { busy: undefined, updating: undefined }, 1_500, false)).toEqual(clicked);
    });

    it('busy marks it started; busy gone after that ends it', () => {
        const started = nextInFlight(clicked, { busy: 'Installing composer', updating: undefined }, 2_000, false);
        expect(started).toEqual({ ...clicked, started: true });
        expect(nextInFlight(started, { busy: undefined, updating: undefined }, 3_000, false)).toBeNull();
    });

    it('an update in flight counts as started, and so does a pending click', () => {
        expect(nextInFlight(clicked, { busy: undefined, updating: { tool: 'git', step: 'x' } }, 2_000, false)).toEqual({ ...clicked, started: true });
        expect(nextInFlight({ ...clicked, started: true }, { busy: undefined, updating: undefined }, 2_000, true)).toEqual({ ...clicked, started: true });
    });

    it('a click whose work never started is let go after a minute', () => {
        expect(nextInFlight(clicked, { busy: undefined, updating: undefined }, 1_000 + 60_001, false)).toBeNull();
        expect(nextInFlight(null, { busy: 'x', updating: undefined }, 0, false)).toBeNull();
    });
});
