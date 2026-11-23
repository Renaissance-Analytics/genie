import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE MAXIMIZED QUESTION IS PROVEN ON BOTH PLATFORMS (Tynn #1019). scripts/question-maximize-cdp.mjs grows a real window
 * to the display's work area and restores it: a window's maximize is the operating system's, so a row on Linux alone says
 * nothing of Windows. It is a row of both CI scripts, registered the way sound-picker is: in the row list, with its
 * function, its ceiling, and (Linux) the list of rows whose leftovers are reaped. The same questions are asked of
 * sound-picker first, as the control: a registered row is found by these readings.
 */
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split(/\r?\n/).join('\n');
const code = (text: string, comment: RegExp): string => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const linux = code(read('scripts/ci/linux.sh'), /^\s*#/);
const windows = code(read('scripts/ci/windows.ps1'), /^\s*#/);
const script = code(read('scripts/question-maximize-cdp.mjs'), /^\s*(\/\/|\*|\/\*)/);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** linux.sh's ROWS=( … ) as names. */
const linuxRows = (): string[] => (/^ROWS=\(\n([\s\S]*?)\n\)/m.exec(linux)?.[1] ?? '').split(/\s+/).filter(Boolean);
/** windows.ps1's $Rows = @( … ) as names. */
const windowsRows = (): string[] => [...(/^\$Rows = @\(\n([\s\S]*?)\n\)/m.exec(windows)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
/** The body of linux.sh's ceiling() case for a row: the seconds it echoes, or null. */
const linuxCeiling = (row: string): number | null => {
    const body = /^ceiling\(\) \{\n([\s\S]*?)\n\}/m.exec(linux)?.[1] ?? '';
    const m = new RegExp(`^\\s*(?:[a-z0-9-]+\\|)*${esc(row)}(?:\\|[a-z0-9-]+)*\\) echo (\\d+) ;;`, 'm').exec(body);
    return m ? Number(m[1]) : null;
};
/** windows.ps1's Ceiling for a row, or null. */
const windowsCeiling = (row: string): number | null => {
    const body = /^function Ceiling\(\[string\]\$name\) \{\n([\s\S]*?)\n\}/m.exec(windows)?.[1] ?? '';
    const m = new RegExp(`^\\s*(?:'${esc(row)}'|\\{ \\$_ -in [^}]*'${esc(row)}'[^}]*\\}) \\{ return (\\d+) \\}`, 'm').exec(body);
    return m ? Number(m[1]) : null;
};
/** The rows whose leftovers linux.sh reaps before they start. */
const reaped = (): string[] => (/case " ([a-z0-9 -]+) " in\n\s*\*" \$name "\*\) reap_leftovers/.exec(linux)?.[1] ?? '').split(' ');

describe.each([
    ['sound-picker (CONTROL: a registered row)', 'sound-picker'],
    ['question-maximize (Tynn #1019)', 'question-maximize'],
])('%s is a row of both CI scripts', (_title, row) => {
    it('Linux: in ROWS, with a row function that builds, needs the display, and runs its script under a timeout', () => {
        expect(linuxRows()).toContain(row);
        expect(linux).toMatch(new RegExp(`^row_${esc(row)}\\(\\) \\{ need_build && need_display && on_display timeout \\d+ node scripts/${esc(row)}-cdp\\.mjs; \\}$`, 'm'));
    });

    it('Linux: it has a ceiling above its own timeout, and its leftovers are reaped before it starts', () => {
        const own = Number(new RegExp(`^row_${esc(row)}\\(\\) .* timeout (\\d+) node`, 'm').exec(linux)?.[1] ?? NaN);
        expect(linuxCeiling(row)).not.toBeNull();
        expect(linuxCeiling(row)!).toBeGreaterThan(own);
        expect(reaped()).toContain(row);
    });

    it('Windows: in $Rows, with a Row function that builds, needs a test machine, and runs its script', () => {
        expect(windowsRows()).toContain(row);
        expect(windows).toMatch(new RegExp(`^function Row-${esc(row)} \\{ Need-Build; Need-TestMachine; Run '${esc(row)}-cdp' \\{ node scripts/${esc(row)}-cdp\\.mjs \\} \\}$`, 'm'));
    });

    it('Windows: it has a ceiling', () => {
        expect(windowsCeiling(row)).not.toBeNull();
        expect(windowsCeiling(row)!).toBeGreaterThanOrEqual(240);
    });
});

describe('scripts/question-maximize-cdp.mjs runs on both platforms', () => {
    it('CONTROL: it is the script that maximizes the question window and restores it', () => {
        expect(script).toMatch(/question-maximize-/);
        expect(script).toMatch(/Maximize/);
    });

    it("ends the app it started on Windows through the rows' one cleanup (Tynn #1031), and fails when something of the run is left", () => {
        expect(script).toMatch(/const ended = await endOwnRun\(\{ app, hostPid: host, since: RUN_BEGAN \}\);/);
        expect(script).toMatch(/check\(ended\.ok, 'nothing of this run is left running by its own cleanup'/);
    });

    it('passes --no-sandbox on Linux only, and gives the app a profile folder of its own on Windows', () => {
        expect(script).toMatch(/process\.platform === 'linux' \? \['--no-sandbox'\] : \[\]/);
        expect(script).toMatch(/join\(home, 'AppData', 'Roaming'\)/);
    });
});
