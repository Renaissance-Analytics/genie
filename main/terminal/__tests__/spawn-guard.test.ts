import { describe, expect, it } from 'vitest';
import { SpawnGuard, SPAWN_LIMIT, SPAWN_WINDOW_MS } from '../spawn-guard';

/**
 * A PROCESS THAT CANNOT START MUST EVENTUALLY BE LEFT ALONE.
 *
 * Three worker processes respawned every five or six seconds for five days —
 * 9,306 starts. In the twenty minutes before the shared pty host died of an
 * access violation with 22 terminals live, there were 684 spawn requests and 678
 * of them were those three. The loop was not just noise; constant pty
 * create/teardown is what faults ConPTY, so it was taking the machine down.
 *
 * The exponential backoff those restarts were supposed to follow is correct and
 * was not the path they took — a flat five-second period is not a point on a
 * 1/2/4/8/16 curve. So this does not patch another path. It sits at the single
 * place a process pty is created and refuses a spec that is looping, whichever
 * code asked and for whatever reason.
 *
 * The numbers matter as much as the mechanism: a guard that fires on healthy
 * behaviour gets turned off, and then it protects nothing.
 */
const at = (t: { v: number }) => () => t.v;

describe('a looping process is refused', () => {
    it('allows a healthy burst and then refuses', () => {
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));

        for (let i = 0; i < SPAWN_LIMIT; i++) {
            expect(g.check('p1').refuse, `start ${i + 1} should be allowed`).toBe(false);
            t.v += 100;
        }

        expect(g.check('p1').refuse).toBe(true);
    });

    it('reports how many starts it has seen, so the refusal can explain itself', () => {
        // A refusal that cannot say why is the silent failure this codebase keeps
        // producing. The count is what makes the log line worth reading.
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));
        for (let i = 0; i < 4; i++) {
            g.check('p1');
            t.v += 100;
        }

        expect(g.check('p1').recent).toBe(5);
    });

    it('counts REFUSED attempts too, so hammering cannot age out the history', () => {
        // A caller that ignores the verdict and keeps asking must not be able to
        // push its own record out of the window by asking faster.
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));
        for (let i = 0; i <= SPAWN_LIMIT; i++) {
            g.check('p1');
            t.v += 10;
        }
        expect(g.check('p1').refuse).toBe(true);

        // Keep hammering inside the window — it must stay refused, not recover.
        for (let i = 0; i < 50; i++) {
            t.v += 10;
            expect(g.check('p1').refuse).toBe(true);
        }
    });
});

describe('what it must NOT do', () => {
    it('CONTROL: a process restarting on the real backoff curve is never refused', () => {
        // 1s, 2s, 4s, 8s, 16s — the whole exponential sequence, five starts in
        // just over half a minute. If this ever trips, the guard is firing on
        // correct behaviour and would be switched off, protecting nothing.
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));

        for (const delay of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
            t.v += delay;
            expect(g.check('svc').refuse, `backoff step +${delay}ms was refused`).toBe(false);
        }
    });

    it('forgets history once the window has passed', () => {
        // A process that failed this morning and is started again this afternoon
        // is not looping. Without this the guard would be a permanent ban.
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));
        for (let i = 0; i <= SPAWN_LIMIT; i++) g.check('p1');
        expect(g.check('p1').refuse).toBe(true);

        t.v += SPAWN_WINDOW_MS + 1;

        expect(g.check('p1').refuse).toBe(false);
    });

    it('keeps specs apart — one loop must not refuse everything else', () => {
        // The failure this protects against takes down every terminal at once.
        // A guard that responded by blocking healthy processes would be doing
        // the same damage from the other direction.
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));
        for (let i = 0; i <= SPAWN_LIMIT; i++) g.check('looping');

        expect(g.check('looping').refuse).toBe(true);
        expect(g.check('innocent').refuse).toBe(false);
    });

    it('yields to a person who acts anyway', () => {
        // Someone told a process is looping, who starts it regardless, has the
        // evidence in front of them. This stops an automatic loop, not a human.
        const t = { v: 1_000 };
        const g = new SpawnGuard(at(t));
        for (let i = 0; i <= SPAWN_LIMIT; i++) g.check('p1');
        expect(g.check('p1').refuse).toBe(true);

        g.clear('p1');

        expect(g.check('p1').refuse).toBe(false);
    });
});

describe('the ceiling is far above anything healthy', () => {
    it('sits well clear of the fastest the backoff curve can go', () => {
        // Stated as an assertion so a future tweak to either number has to look
        // at the other. The curve manages 5 starts in a minute at its fastest;
        // the crashloop managed 12. The limit belongs between them.
        expect(SPAWN_LIMIT).toBeGreaterThan(5);
        expect(SPAWN_LIMIT).toBeLessThan(12);
        expect(SPAWN_WINDOW_MS).toBe(60_000);
    });
});
