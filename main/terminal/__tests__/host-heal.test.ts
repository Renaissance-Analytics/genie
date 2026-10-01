import { describe, expect, it } from 'vitest';
import { shouldAttemptHostHeal, HOST_HEAL_MIN_INTERVAL_MS } from '../host-heal';

/**
 * SELF-HEALING: notice we are degraded, and get a host back (genie#774).
 *
 * The owner, after a day without terminals: *"the upgrade should bring that back
 * up. we should never have to manually fix issues, genie should handle that."*
 *
 * Two fixes already landed either side of this one, and neither covers the state
 * the machine was actually IN:
 *
 *  - adopting a serving host stops the collision that kills the fleet;
 *  - retrying the respawn stops a transient `EADDRINUSE` degrading permanently.
 *
 * Both act at the MOMENT of a loss. Neither helps a Genie that is already sitting
 * on the in-process backend with no host — which is where this machine sat for
 * hours, killing every agent on every restart, until a human noticed. Nothing
 * announces that state, so nothing was ever going to react to it.
 *
 * This is the decision half: GIVEN what we can observe, should we try to heal
 * right now? Kept pure because every rule in it is a way of not making things
 * worse — and "worse" here means respawning a host under a working one, which is
 * the original incident.
 */
const base = {
    detachedEnabled: true,
    hostBacked: false,
    inFlight: false,
    lastAttemptAt: null as number | null,
    now: 1_000_000,
};

describe('shouldAttemptHostHeal', () => {
    it('heals when the backend is degraded and nothing is in flight', () => {
        expect(shouldAttemptHostHeal(base).heal).toBe(true);
    });

    it('does NOTHING when a host is already backing terminals', () => {
        // THE most important refusal. Running selection against a healthy host is
        // what genie#774 is about — it is how the fleet died in the first place.
        const out = shouldAttemptHostHeal({ ...base, hostBacked: true });
        expect(out.heal).toBe(false);
        expect(out.reason).toMatch(/healthy|backed/i);
    });

    it('does nothing when detached terminals are turned OFF', () => {
        // In-process is the CHOSEN state then, not a degradation. Healing it
        // would resurrect a backend the user switched off.
        const out = shouldAttemptHostHeal({ ...base, detachedEnabled: false });
        expect(out.heal).toBe(false);
        expect(out.reason).toMatch(/off|disabled/i);
    });

    it('does nothing while an attempt is already in flight', () => {
        // Selection is not re-entrant, and two concurrent selections are two
        // processes racing for one pipe — the incident, reproduced by the cure.
        expect(shouldAttemptHostHeal({ ...base, inFlight: true }).heal).toBe(false);
    });

    it('does not retry faster than the minimum interval', () => {
        // A heal that fails must not become a spawn loop. On a machine that
        // genuinely cannot host terminals this is the difference between a quiet
        // fallback and a process storm.
        const out = shouldAttemptHostHeal({
            ...base,
            lastAttemptAt: base.now - (HOST_HEAL_MIN_INTERVAL_MS - 1),
        });
        expect(out.heal).toBe(false);
        expect(out.reason).toMatch(/recently|interval|soon/i);
    });

    it('DOES retry once the interval has elapsed', () => {
        // POSITIVE CONTROL for the rate limit: it must throttle, not latch. A
        // limiter that never reopens is a machine that heals once and then never
        // again for the rest of the session.
        expect(
            shouldAttemptHostHeal({
                ...base,
                lastAttemptAt: base.now - HOST_HEAL_MIN_INTERVAL_MS,
            }).heal,
        ).toBe(true);
    });

    it('is quiet enough not to be a spawn loop, and quick enough to be useful', () => {
        // Stated as a range rather than a number so the intent survives a tweak:
        // long enough that a failing machine is not respawning constantly, short
        // enough that a user who looks at Genie is not waiting minutes for their
        // terminals.
        expect(HOST_HEAL_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(15_000);
        expect(HOST_HEAL_MIN_INTERVAL_MS).toBeLessThanOrEqual(120_000);
    });

    it('treats a never-attempted heal as eligible', () => {
        expect(shouldAttemptHostHeal({ ...base, lastAttemptAt: null }).heal).toBe(true);
    });

    it('always says WHY it refused', () => {
        // This runs on a timer and on focus; without a reason a user asking "why
        // are my terminals still dead" gets silence from the one component whose
        // job was to fix it.
        for (const over of [
            { hostBacked: true },
            { detachedEnabled: false },
            { inFlight: true },
            { lastAttemptAt: base.now },
        ]) {
            const out = shouldAttemptHostHeal({ ...base, ...over });
            expect(out.heal).toBe(false);
            expect(out.reason).toBeTruthy();
        }
    });
});

/**
 * The decision above is inert unless something CALLS it. `armHostHealthHeal` is
 * invoked from one line in `background.ts`, inside the same branch that arms the
 * loss watchdog — delete that line and every test here still passes while a
 * degraded machine never heals again. `main/background.ts` has no unit harness
 * (it drags the Electron bootstrap in), so the wire is guarded in source.
 */
import fs from 'node:fs';
import path from 'node:path';

const BACKGROUND = fs.readFileSync(
    path.resolve(__dirname, '../../background.ts'),
    'utf8',
);

describe('the heal is actually wired up', () => {
    it('is armed where the loss watchdog is armed', () => {
        // Matched as a STATEMENT, not just the identifier: `armHostHealthHeal()`
        // also appears in its own `function armHostHealthHeal(): void` header, so
        // a bare identifier match stays green with the call site deleted. Caught
        // by mutation — the first version of this test did exactly that.
        expect(BACKGROUND).toMatch(/^\s+armHostHealthHeal\(\);$/m);
    });

    it('heals on window focus — the moment someone looks at Genie', () => {
        expect(BACKGROUND).toMatch(/browser-window-focus/);
        expect(BACKGROUND).toMatch(/attemptHostHeal\('focus'\)/);
    });

    it('also has a backstop sweep, for a machine nobody is looking at', () => {
        // A headless host has no window to focus, and a machine left overnight
        // should still come back without a human.
        expect(BACKGROUND).toMatch(/attemptHostHeal\('sweep'\)/);
    });

    it('asks shouldAttemptHostHeal rather than deciding inline', () => {
        // Every refusal lives in the pure function, including the one that
        // matters: never re-select while a host IS backing terminals.
        expect(BACKGROUND).toMatch(/shouldAttemptHostHeal\(\{/);
    });

    it('refuses to heal when the host-backed probe THROWS', () => {
        // "Cannot tell" is not "degraded". Healing on a failed probe would
        // respawn underneath a host that may be perfectly healthy — which is
        // genie#774 itself.
        expect(BACKGROUND).toMatch(/catch\s*\{[^}]*\n\s*\/\/ Cannot tell is not degraded/);
    });
});
