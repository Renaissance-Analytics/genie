import { describe, expect, it } from 'vitest';
import { shouldFit } from '../terminal-fit';

/**
 * Never fit a terminal that is not on screen (genie#229).
 *
 * Off-workspace panels are kept mounted-hidden (`display: none`) so their ptys
 * survive a workspace switch. A hidden element measures **0×0**, and Chromium's
 * ResizeObserver fires for that transition — so the refit-on-resize safeguard ran
 * against a zero-size container and pushed a nonsense geometry all the way through
 * to the pty.
 *
 * The damage outlives the hiding. A TUI told it has ~no columns REFLOWS ITS OUTPUT
 * to that width, and that scrollback is already written by the time the panel comes
 * back: switching workspaces returned a terminal whose history was wrapped at a
 * width the window never had. First characters clipped off the left, the tails
 * spilling into a sliver down the right — exactly what was reported.
 *
 * So a zero measurement means "not visible", never "a very small terminal".
 */

describe('a container with no size', () => {
    it('is not fitted — it is hidden, not tiny', () => {
        expect(shouldFit({ width: 0, height: 0 })).toBe(false);
    });

    it('is not fitted when only ONE axis has collapsed', () => {
        // A panel mid-animation, or a flex child that has not been given its
        // height yet. Either way the measurement is not the terminal's real size.
        expect(shouldFit({ width: 800, height: 0 })).toBe(false);
        expect(shouldFit({ width: 0, height: 600 })).toBe(false);
    });

    it('is not fitted at a size no terminal can be', () => {
        // A few pixels cannot hold a single cell. Fitting there produces the same
        // nonsense geometry as zero, just less obviously.
        expect(shouldFit({ width: 4, height: 600 })).toBe(false);
        expect(shouldFit({ width: 800, height: 4 })).toBe(false);
    });
});

describe('a container that is really there', () => {
    it('is fitted', () => {
        expect(shouldFit({ width: 800, height: 600 })).toBe(true);
    });

    it('is fitted when small but usable — a narrow split is still a terminal', () => {
        expect(shouldFit({ width: 120, height: 60 })).toBe(true);
    });
});

describe('measurements that are not measurements', () => {
    it('refuses anything that is not a finite number', () => {
        // A detached node, a stale ref, a rect read mid-teardown. Fitting on any
        // of these writes a geometry nobody asked for.
        for (const bad of [NaN, Infinity, -1, undefined, null]) {
            expect(shouldFit({ width: bad as number, height: 600 }), String(bad)).toBe(false);
            expect(shouldFit({ height: bad as number, width: 600 }), String(bad)).toBe(false);
        }
    });

    it('refuses a missing rect outright', () => {
        expect(shouldFit(null)).toBe(false);
        expect(shouldFit(undefined)).toBe(false);
    });
});
