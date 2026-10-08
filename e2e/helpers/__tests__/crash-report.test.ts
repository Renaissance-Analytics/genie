import { describe, expect, it, vi } from 'vitest';
import { attachCrashReporter, crashDumpDir } from '../launch';

/**
 * A RENDERER CRASH MUST NAME ITSELF, because five occurrences have produced no diagnosis.
 *
 * genie#667 has been open since run `34778060990` with this and only this:
 *
 * ```
 * Error: page.reload: Page crashed
 * ```
 *
 * That message is Playwright reporting that the renderer went away — raised by whatever command
 * happened to run next, which is why the tally reads as "it moves between specs". It is **not** the
 * crash; it is the first statement to notice one. Nobody has the reason, which is exactly why four
 * comments of occurrences have added rows to a table and no cause.
 *
 * Five occurrences now, across all three platforms and two specs, and one of them on a **docs-only
 * diff** — a single markdown file, which rules out every "a recent change caused it" hypothesis by
 * construction. At roughly one job in three, the green that gates a release is being manufactured by
 * re-running rather than earned, which this issue itself names as the reason it survives.
 *
 * ## What this adds, and what it deliberately does not
 *
 * A `crash` listener on every page the rig opens, logging AT THE MOMENT it happens with the harness
 * that was running. Diagnostics only: it changes no product code and no test behaviour, so it cannot
 * mask the thing it is reporting — the same reason the dump directory is only *reported*, never
 * cleaned.
 *
 * It does not attempt a fix. A `page.reload()` after an `app.evaluate()` state write is the one thing
 * all five share, and that is a hypothesis; shipping a `waitForLoadState` against it would most
 * likely hide the crash rather than explain it, and a flake that stops reproducing without a reason
 * is worse than one that still does.
 */

describe('attachCrashReporter', () => {
    /** The two Playwright surfaces this touches, and nothing else. */
    const fakePage = () => {
        const handlers = new Map<string, (...a: unknown[]) => void>();
        return {
            on: (event: string, fn: (...a: unknown[]) => void) => handlers.set(event, fn),
            fire: (event: string, ...a: unknown[]) => handlers.get(event)?.(...a),
            has: (event: string) => handlers.has(event),
        };
    };

    it('subscribes to the page CRASH event', () => {
        const page = fakePage();
        attachCrashReporter(page as never, 'hosting');
        expect(page.has('crash')).toBe(true);
    });

    it('names the HARNESS, so a crash is attributable without reading the whole log', () => {
        // Five occurrences across two specs. "Page crashed" with no harness means working out which
        // window died from the surrounding lines, which is how four reports produced four table rows.
        const logged: string[] = [];
        const page = fakePage();
        attachCrashReporter(page as never, 'issuewatch', (m) => logged.push(m));
        page.fire('crash');
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('issuewatch');
    });

    it('says RENDERER CRASHED in words a log search will find', () => {
        // Deliberately not the Playwright phrasing: `page.reload: Page crashed` is what the NEXT
        // command reports. This line marks the moment itself, so the two can be told apart in a log
        // where both appear.
        const logged: string[] = [];
        const page = fakePage();
        attachCrashReporter(page as never, 'master', (m) => logged.push(m));
        page.fire('crash');
        expect(logged[0]).toMatch(/renderer crashed/i);
    });

    it('points at the crash dump directory, so the minidump is findable', () => {
        const logged: string[] = [];
        const page = fakePage();
        attachCrashReporter(page as never, 'master', (m) => logged.push(m));
        page.fire('crash');
        expect(logged[0]).toContain(crashDumpDir());
    });

    it('returns the page, so it can be used inline without a temporary', () => {
        const page = fakePage();
        expect(attachCrashReporter(page as never, 'master')).toBe(page);
    });

    it('a throwing logger does not take the launch down with it', () => {
        // Reached from the launch path. A diagnostic that can fail a launch is worse than no
        // diagnostic — it would turn a crash nobody has diagnosed into a launch nobody can perform.
        const page = fakePage();
        attachCrashReporter(page as never, 'master', () => {
            throw new Error('log sink gone');
        });
        expect(() => page.fire('crash')).not.toThrow();
    });
});

describe('crashDumpDir', () => {
    it('sits inside the E2E profile, which is where --user-data-dir sends it', () => {
        // Electron/Crashpad writes minidumps under the user-data dir, and the rig passes
        // `--user-data-dir=${E2E_USERDATA}`. Naming it here is what lets the workflow copy dumps into
        // `test-results/` for the artifact upload, rather than the path being implied in two places.
        expect(crashDumpDir()).toContain('genie-e2e-profile');
        expect(crashDumpDir().toLowerCase()).toContain('crashpad');
    });

    it('is absolute, so a workflow step can use it without resolving cwd', () => {
        const d = crashDumpDir();
        expect(d === require('node:path').resolve(d)).toBe(true);
    });
});

// A guard against the listener being dropped from the launch path — the defect class this phase has
// spent its time on is "built, tested, and not wired", and a diagnostic nobody attaches is exactly
// that with a smaller blast radius.
describe('the launch path attaches it', () => {
    const src = require('node:fs')
        .readFileSync(require('node:path').resolve(__dirname, '../launch.ts'), 'utf8')
        .replace(/\r\n/g, '\n');

    it('calls attachCrashReporter on the page it returns', () => {
        expect(src).toContain('attachCrashReporter(page, harness)');
    });

    it('positive control: the guard reads the real file', () => {
        expect(src).toContain('export async function launchGenieE2E');
        expect(src).not.toContain('attachCrashReporterThatDoesNotExist');
    });
});
