/**
 * Loop prevention — a requirement, not a refinement.
 *
 * The reference case WRITES A FILE. If "file added" fires on that write, the
 * Wish moves the file it just moved, forever. So every assertion here has a
 * positive control beside it: a guard that blocks everything would pass every
 * "did not loop" test while being completely useless, and that failure mode is
 * indistinguishable from success unless something proves the legitimate second
 * trigger still fires.
 */

import { describe, expect, it } from 'vitest';
import { WishLoopGuard } from '../loop';
import type { WishEvent } from '../types';

function event(props: Record<string, string | number>, source: WishEvent['source']): WishEvent {
    return { event: 'demo:happened', props, source };
}

describe('an echo of a Wish’s own action does not retrigger it', () => {
    it('re-attributes the echo to the run that caused it, and blocks only that Wish', () => {
        const guard = new WishLoopGuard();
        guard.declareEffect({
            wishId: 'mover',
            runId: 'run-1',
            event: 'demo:happened',
            match: { path: '/ws/.large/big.bin' },
        });

        // Arrives out of band, from a watcher that has no idea who wrote it.
        const echo = guard.attribute(event({ path: '/ws/.large/big.bin' }, { kind: 'system' }));
        expect(echo.source).toEqual({ kind: 'wish', wishId: 'mover', runId: 'run-1', depth: 1 });

        expect(guard.admit('mover', echo).ok).toBe(false);

        // POSITIVE CONTROL: the guard is not a blanket mute. Another Wish that
        // legitimately watches the same path still gets to run.
        expect(guard.admit('auditor', echo).ok).toBe(true);
    });

    it('consumes the echo once, so a genuinely new file at that path still fires', () => {
        const guard = new WishLoopGuard();
        guard.declareEffect({
            wishId: 'mover',
            runId: 'run-1',
            event: 'demo:happened',
            match: { path: '/ws/.large/big.bin' },
        });

        const first = guard.attribute(event({ path: '/ws/.large/big.bin' }, { kind: 'system' }));
        expect(guard.admit('mover', first).ok).toBe(false);

        // THE control that matters: the SAME event again is a real one.
        const second = guard.attribute(event({ path: '/ws/.large/big.bin' }, { kind: 'system' }));
        expect(second.source).toEqual({ kind: 'system' });
        expect(guard.admit('mover', second).ok).toBe(true);
    });

    it('matches an echo on the declared props only, ignoring the rest', () => {
        const guard = new WishLoopGuard();
        guard.declareEffect({
            wishId: 'mover',
            runId: 'run-1',
            event: 'demo:happened',
            match: { path: '/ws/.large/big.bin' },
        });

        const echo = guard.attribute(
            event({ path: '/ws/.large/big.bin', sizeBytes: 9_000_000 }, { kind: 'system' }),
        );
        expect(echo.source).toMatchObject({ kind: 'wish', wishId: 'mover' });

        // A different path is a different file — not an echo.
        const other = guard.attribute(event({ path: '/ws/other.bin' }, { kind: 'system' }));
        expect(other.source).toEqual({ kind: 'system' });
    });

    it('lets a declared echo expire, so a stale entry cannot mute a later event', () => {
        let now = 1_000;
        const guard = new WishLoopGuard({ echoWindowMs: 5_000, now: () => now });
        guard.declareEffect({
            wishId: 'mover',
            runId: 'run-1',
            event: 'demo:happened',
            match: { path: '/ws/.large/big.bin' },
        });

        now += 5_001;
        const late = guard.attribute(event({ path: '/ws/.large/big.bin' }, { kind: 'system' }));
        expect(late.source).toEqual({ kind: 'system' });
        expect(guard.admit('mover', late).ok).toBe(true);
    });
});

describe('a chain of Wishes cannot run away', () => {
    it('stops at the depth limit and admits everything below it', () => {
        const guard = new WishLoopGuard({ maxDepth: 3 });

        for (let depth = 0; depth < 3; depth++) {
            const e = event({}, { kind: 'wish', wishId: 'other', runId: 'r', depth });
            expect(guard.admit('mine', e).ok, `depth ${depth} should be admitted`).toBe(true);
        }

        const tooDeep = event({}, { kind: 'wish', wishId: 'other', runId: 'r', depth: 3 });
        const decision = guard.admit('mine', tooDeep);
        expect(decision.ok).toBe(false);
        expect(decision.ok === false && decision.code).toBe('max-depth');
    });

    it('deepens the chain by one for the events a run causes', () => {
        const guard = new WishLoopGuard();
        const triggering = event({}, { kind: 'wish', wishId: 'a', runId: 'r1', depth: 1 });
        expect(guard.sourceFor('b', 'r2', triggering)).toEqual({
            kind: 'wish',
            wishId: 'b',
            runId: 'r2',
            depth: 2,
        });
        expect(guard.sourceFor('b', 'r2', undefined)).toEqual({
            kind: 'wish',
            wishId: 'b',
            runId: 'r2',
            depth: 1,
        });
    });

    it('never lets a Wish be triggered by its own emission, at any depth', () => {
        const guard = new WishLoopGuard();
        const own = event({}, { kind: 'wish', wishId: 'mine', runId: 'r', depth: 0 });
        const decision = guard.admit('mine', own);
        expect(decision.ok).toBe(false);
        expect(decision.ok === false && decision.code).toBe('self-source');

        // POSITIVE CONTROL: the identical event from a different run is fine.
        const theirs = event({}, { kind: 'wish', wishId: 'theirs', runId: 'r', depth: 0 });
        expect(guard.admit('mine', theirs).ok).toBe(true);
    });
});

describe('the circuit breaker is a backstop, not the mechanism', () => {
    it('quarantines a Wish that runs too often, and forgets once the window passes', () => {
        let now = 0;
        const guard = new WishLoopGuard({ maxRunsPerWindow: 3, runWindowMs: 1_000, now: () => now });
        const e = event({}, { kind: 'system' });

        for (let i = 0; i < 3; i++) {
            expect(guard.admit('busy', e).ok, `run ${i} should be admitted`).toBe(true);
            guard.noteRun('busy');
        }

        const tripped = guard.admit('busy', e);
        expect(tripped.ok).toBe(false);
        expect(tripped.ok === false && tripped.code).toBe('rate-limit');

        // POSITIVE CONTROL 1: another Wish is unaffected — the breaker is per-Wish.
        expect(guard.admit('calm', e).ok).toBe(true);

        // POSITIVE CONTROL 2: it is a rolling window, not a permanent ban.
        now += 1_001;
        expect(guard.admit('busy', e).ok).toBe(true);
    });
});
