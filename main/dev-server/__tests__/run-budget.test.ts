import { describe, expect, it } from 'vitest';
import {
    INSTALL_BUDGET_MS,
    INSTALL_CEILING_MS,
    INSTALL_IDLE_GRACE_MS,
    INSTALL_RUN_OPTIONS,
    extendedDeadline,
    formatRunTimeout,
} from '../run-budget';

/**
 * HOW LONG AN INSTALL MAY TAKE, and what to say when we stop waiting.
 *
 * The bug this exists for: the setup wizard ran `winget install --id Git.Git`
 * through the plain command runner with NO `timeoutMs`, so it inherited the
 * container adapter's `docker ps`-sized default of 120 000 ms. Git is the first
 * entry in `INSTALL_ORDER` and the only winget call in a normal run, so it alone
 * pays winget's first-use cost (source agreements + a source refresh) before a
 * ~70 MB download even starts. It failed at two minutes; the six tools after it
 * — engine installs, direct downloads, `npm i -g` — all succeeded.
 *
 * A flat wall-clock cap is the wrong instrument: how long a package install
 * takes depends on the package, the machine and the link, none of which Genie
 * knows. So the budget is a FLOOR, not a wall — a command that is still
 * producing output when the floor expires is not hung, and gets more time, up to
 * a ceiling that catches something genuinely wedged.
 */

describe('the install budget', () => {
    it('is generous enough for a real package install, not a probe', () => {
        // The number the elevated path and the artifact installers already use.
        // The bug was that ONE path — the unelevated runner — did not.
        expect(INSTALL_BUDGET_MS).toBe(15 * 60_000);
        expect(INSTALL_BUDGET_MS).toBeGreaterThan(120_000);
    });

    it('ships as run options an install call can pass straight through', () => {
        expect(INSTALL_RUN_OPTIONS.timeoutMs).toBe(INSTALL_BUDGET_MS);
        expect(INSTALL_RUN_OPTIONS.idleGraceMs).toBe(INSTALL_IDLE_GRACE_MS);
        expect(INSTALL_RUN_OPTIONS.ceilingMs).toBe(INSTALL_CEILING_MS);
        // The note is what turns "timed out" into something a user can act on.
        expect(INSTALL_RUN_OPTIONS.timeoutNote).toBeTruthy();
    });

    it('caps extension well above the floor, so a wedged install still ends', () => {
        expect(INSTALL_CEILING_MS).toBeGreaterThan(INSTALL_BUDGET_MS);
    });
});

describe('extendedDeadline — output means alive', () => {
    const base = {
        startedAt: 0,
        idleGraceMs: 5 * 60_000,
        ceilingMs: 30 * 60_000,
    };

    it('pushes the deadline out when a late chunk proves the process is alive', () => {
        // 14 minutes in, one line of output. Without this the command dies at 15.
        expect(
            extendedDeadline({ ...base, now: 14 * 60_000, deadline: 15 * 60_000 }),
        ).toBe(19 * 60_000);
    });

    it('NEVER shortens the deadline — early chatter must not cut the floor short', () => {
        // The trap: `now + idleGrace` at one second in is 5m01s, far short of the
        // 15-minute floor. Taking it would make a chatty install fail SOONER than
        // a silent one.
        expect(extendedDeadline({ ...base, now: 1_000, deadline: 15 * 60_000 })).toBe(
            15 * 60_000,
        );
    });

    it('stops extending at the ceiling, so endless chatter is not endless waiting', () => {
        expect(
            extendedDeadline({ ...base, now: 29 * 60_000, deadline: 29 * 60_000 }),
        ).toBe(30 * 60_000);
    });

    it('never returns a deadline before the ceiling once already past it', () => {
        expect(
            extendedDeadline({ ...base, now: 31 * 60_000, deadline: 30 * 60_000 }),
        ).toBe(30 * 60_000);
    });

    it('does not shorten even when handed a ceiling below the deadline', () => {
        // A caller that passes `idleGraceMs` without a sensible `ceilingMs` must
        // not end up with LESS time than it asked for. The ceiling bounds
        // extension; it is not permission to cut the budget.
        expect(
            extendedDeadline({
                startedAt: 0,
                now: 60_000,
                deadline: 15 * 60_000,
                idleGraceMs: 60_000,
                ceilingMs: 2 * 60_000,
            }),
        ).toBe(15 * 60_000);
    });
});

describe('formatRunTimeout — the message the user actually reads', () => {
    const note = 'Genie stopped waiting.';

    it('says how long in units a human reads, not milliseconds', () => {
        // "timed out after 120000ms" is what the reporter saw. It says nothing.
        const msg = formatRunTimeout('winget install --id Git.Git', 15 * 60_000, note);
        expect(msg).toContain('15 minutes');
        expect(msg).not.toContain('900000ms');
    });

    it('names the command that stopped, so the row is traceable', () => {
        expect(formatRunTimeout('winget install --id Git.Git', 60_000, note)).toContain(
            'winget install --id Git.Git',
        );
    });

    it('carries the caller note — this is the actionable half', () => {
        expect(formatRunTimeout('winget install', 60_000, note)).toContain(note);
    });

    it('stays terse with no note, for the probe calls that never had one', () => {
        const msg = formatRunTimeout('docker ps', 120_000, undefined);
        expect(msg).toContain('docker ps');
        expect(msg).toContain('2 minutes');
        expect(msg.trim().endsWith('.')).toBe(true);
    });

    it('reads seconds below a minute rather than "0 minutes"', () => {
        expect(formatRunTimeout('git --version', 10_000, undefined)).toContain('10 seconds');
    });

    it('rounds to whole units instead of leaking float noise', () => {
        expect(formatRunTimeout('x', 90_500, undefined)).toContain('2 minutes');
        expect(formatRunTimeout('x', 1_499, undefined)).toContain('1 second');
    });

    it('fits the 400-character tail a wizard row keeps', () => {
        // `toolchain-perform` shows only the last 400 chars of stderr. A message
        // longer than that arrives truncated at the FRONT, losing the command.
        const worst = formatRunTimeout(
            'winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements',
            15 * 60_000,
            INSTALL_RUN_OPTIONS.timeoutNote,
        );
        expect(worst.length).toBeLessThanOrEqual(400);
    });
});

describe('the install timeout note', () => {
    const note = INSTALL_RUN_OPTIONS.timeoutNote ?? '';

    it('does not claim the installer was stopped — on Windows it was not', () => {
        // `child.kill()` reaches the direct child only. A host-tool install on
        // win32 is spawned through cmd.exe, so TerminateProcess hits the SHELL;
        // winget and the installer it launched keep running to completion.
        expect(note.toLowerCase()).not.toMatch(/\bcancell?ed\b|\baborted\b/);
        expect(note).toMatch(/still|background/i);
    });

    it('tells the user what to do next', () => {
        expect(note).toMatch(/re-run|wait|minute/i);
    });
});
