import { describe, expect, it } from 'vitest';
import { defaultCommandRunner } from '../seams';
import { INSTALL_TIMEOUT_NOTE } from '../run-budget';

/**
 * WHEN THE RUNNER STOPS WAITING — against real processes, because the thing
 * under test is a spawn and its timers.
 *
 * The reported failure was `winget install --id Git.Git … timed out after
 * 120000ms`: a package install inheriting the probe-sized default. The decisions
 * are pure and proven in `run-budget.test.ts`; what THIS file proves is that
 * `runCaptured` actually wires them — that output really does buy more time,
 * that the extension really is bounded, and that the message a wizard row shows
 * is the useful one.
 *
 * Every timing here is milliseconds rather than minutes, and each assertion has
 * its opposite alongside it: "the process survived" is worthless without the
 * same script dying under the same budget with the extension switched off,
 * because a runner that had stopped timing out at all would pass the first on
 * its own.
 *
 * The budgets are seconds, not the few hundred milliseconds the logic needs,
 * and that is deliberate. The deadline runs from the SPAWN, so anything tighter
 * measures how long `node -e` takes to boot under whatever else the suite is
 * doing — this file's first version failed exactly that way inside the full run
 * while passing alone. Every budget below leaves more than a second of slack
 * before the first chunk is due.
 */

/** Print a dot every `everyMs` for `forMs`, then exit cleanly. */
const chatty = (everyMs: number, forMs: number) =>
    `const t=setInterval(()=>process.stdout.write('.'),${everyMs});` +
    `setTimeout(()=>{clearInterval(t);process.exit(0);},${forMs});`;

/** Print a dot every `everyMs` and never stop. */
const chatterForever = (everyMs: number) =>
    `setInterval(()=>process.stdout.write('.'),${everyMs});`;

/** Sit there saying nothing — the shape of a genuinely wedged process. */
const silent = (forMs: number) => `setTimeout(()=>process.exit(0),${forMs});`;

const node = (script: string, opts: Parameters<typeof defaultCommandRunner.run>[2]) =>
    defaultCommandRunner.run(process.execPath, ['-e', script], opts);

describe('runCaptured — output buys more time', () => {
    it('stops waiting on a SILENT process once its budget expires', async () => {
        // The positive control for everything below: the timer does fire.
        const res = await node(silent(10_000), { timeoutMs: 400 });
        expect(res.code).toBeNull();
        expect(res.stderr).toContain('timed out');
    });

    it('lets a process that is still PRODUCING OUTPUT run past that same budget', async () => {
        const res = await node(chatty(150, 4_500), {
            timeoutMs: 2_000,
            idleGraceMs: 1_200,
            ceilingMs: 60_000,
        });
        // It ran to more than twice its nominal budget and finished on its own.
        expect(res.code).toBe(0);
        expect(res.stdout.length).toBeGreaterThan(1);
    });

    it('kills that SAME script under that SAME budget without the extension', async () => {
        // Without this the test above proves nothing — a runner that had simply
        // stopped enforcing timeouts would pass it.
        const res = await node(chatty(150, 4_500), { timeoutMs: 2_000 });
        expect(res.code).toBeNull();
        expect(res.stderr).toContain('timed out');
    });

    it('stops extending at the ceiling, so endless output is not an endless wait', async () => {
        const started = Date.now();
        const res = await node(chatterForever(100), {
            timeoutMs: 2_000,
            idleGraceMs: 800,
            ceilingMs: 3_500,
        });
        const elapsed = Date.now() - started;
        expect(res.code).toBeNull();
        // Past the floor — the output did extend it — but bounded by the
        // ceiling rather than running as long as the process keeps talking.
        expect(elapsed).toBeGreaterThanOrEqual(2_500);
    });
});

describe('runCaptured — what the timeout says', () => {
    it('reports the wait in human units and names the command', async () => {
        const res = await node(silent(10_000), { timeoutMs: 400 });
        expect(res.stderr).toContain(process.execPath);
        // The exact rendering is pinned in `run-budget.test.ts`; here the point
        // is only that it is no longer the raw milliseconds the reporter saw.
        // Loose about WHICH second, because that is real elapsed time on a
        // loaded CI box, not a decision.
        expect(res.stderr).toMatch(/timed out after \d+ seconds?\./);
        expect(res.stderr).not.toContain('400ms');
    });

    it('carries the caller note, which is the part that says what to do', async () => {
        const res = await node(silent(10_000), {
            timeoutMs: 400,
            timeoutNote: INSTALL_TIMEOUT_NOTE,
        });
        expect(res.stderr).toContain('may still be finishing in the background');
    });

    it('keeps the output the command DID produce before it stopped', async () => {
        // Budget well clear of process startup: the point is that captured
        // output survives the kill, not how fast node boots.
        const res = await node(
            `process.stdout.write('half-done');${silent(30_000)}`,
            { timeoutMs: 2_500 },
        );
        expect(res.code).toBeNull();
        expect(res.stdout).toContain('half-done');
    });
});
