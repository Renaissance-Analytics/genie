import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE PLAN POPOVER'S PROOF IS A ROW THAT RUNS (Tynn #1021). scripts/plan-popover-cdp.mjs was written, run once by hand on
 * a test VM and listed in test/cdp-main-window.test.ts, and no gate ever ran it again: a proof nobody runs is not a proof.
 * It is a row of both CI scripts now, registered the way sound-picker is: in the row list, with its function, its
 * ceiling, and (Linux) the list of rows whose leftovers are reaped. The same four questions are asked of sound-picker
 * first, as the control: a registered row is found by these readings.
 */
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split(/\r?\n/).join('\n');
const code = (text: string, comment: RegExp): string => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const linux = code(read('scripts/ci/linux.sh'), /^\s*#/);
const windows = code(read('scripts/ci/windows.ps1'), /^\s*#/);
const script = code(read('scripts/plan-popover-cdp.mjs'), /^\s*(\/\/|\*|\/\*)/);

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
    ['plan-popover (Tynn #1021)', 'plan-popover'],
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

describe('scripts/plan-popover-cdp.mjs runs on both platforms', () => {
    it('CONTROL: it is the script that hovers the plan cell and measures the popover', () => {
        expect(script).toContain('[data-plan-scroll]');
        expect(script).toMatch(/GENIE_TEST_MACHINE !== '1'/);
    });

    it('does not refuse Windows', () => {
        expect(script).not.toMatch(/process\.platform !== 'linux'\) \{[^}]*process\.exit/);
    });

    it('ends what it started on Windows by pid with its tree (taskkill /T), and never reads `ps` there', () => {
        expect(script).toMatch(/taskkill', \['\/PID', String\([a-zA-Z.]+\), '\/T', '\/F'\]/);
        expect(script).toMatch(/WIN \? '' : .*spawnSync\('ps'/);
    });

    it('gives the app a profile of its own on Windows too, and joins PATH with the platform\'s separator', () => {
        expect(script).toMatch(/APPDATA: join\(home, 'AppData', 'Roaming'\)/);
        expect(script).toMatch(/LOCALAPPDATA: join\(home, 'AppData', 'Local'\)/);
        expect(script).toMatch(/PATH: `\$\{nodeDir\}\$\{delimiter\}/);
    });
});
