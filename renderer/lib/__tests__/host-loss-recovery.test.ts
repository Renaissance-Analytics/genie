import { describe, it, expect } from 'vitest';
import { bumpRecoverGen, panelRecoverKey, recoveryBannerMessage } from '../host-loss-recovery';

/**
 * The framework-free logic behind the master window's host-loss remount + banner
 * (genie#203, Fix C). The renderer has no jsdom harness, so the React pieces
 * (RecoveryBanner, TerminalGrid) stay E2E-only; this pins the pure logic they
 * consume — extracted from master.tsx so a red→green unit test is possible.
 */

describe('bumpRecoverGen', () => {
    it('starts a never-seen id at generation 1', () => {
        expect(bumpRecoverGen({}, ['a'])).toEqual({ a: 1 });
    });

    it('increments an existing generation', () => {
        expect(bumpRecoverGen({ a: 2 }, ['a'])).toEqual({ a: 3 });
    });

    it('bumps every id in one recovery and leaves the rest untouched', () => {
        expect(bumpRecoverGen({ a: 1, b: 5 }, ['a', 'c'])).toEqual({ a: 2, b: 5, c: 1 });
    });

    it('does not mutate the previous map (React setState must get a fresh object)', () => {
        const prev = { a: 1 };
        bumpRecoverGen(prev, ['a']);
        expect(prev).toEqual({ a: 1 });
    });
});

describe('panelRecoverKey', () => {
    it('is id:0 for a terminal never lost (undefined generation)', () => {
        expect(panelRecoverKey('t1', undefined)).toBe('t1:0');
    });

    it('changes only when the generation changes, so reorders/layout never remount', () => {
        expect(panelRecoverKey('t1', 0)).toBe('t1:0');
        expect(panelRecoverKey('t1', 1)).toBe('t1:1');
    });
});

describe('recoveryBannerMessage', () => {
    it('tells the user reconnection is in progress', () => {
        expect(recoveryBannerMessage('recovering')).toBe(
            'Terminal host lost — reconnecting terminals…',
        );
    });

    it('names the recovered-host outcome and the agent restart', () => {
        expect(recoveryBannerMessage('recovered')).toBe(
            'Terminals reconnected (host recovered). Running agents were restarted.',
        );
    });

    it('names the in-process fallback outcome', () => {
        expect(recoveryBannerMessage('degraded')).toBe(
            'Terminals reconnected in-process. Running agents were restarted.',
        );
    });
});
