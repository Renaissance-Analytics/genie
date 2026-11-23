import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE SPLIT'S PROMISE IS A ROW THAT RUNS (Tynn #1036, P6-0). scripts/quit-keeps-host-cdp.mjs proves it on the REAL app with
 * a REAL process table: three agents stream, the window is closed ("Just close the UI") and built again from the tray, then
 * by a second launch, and every agent keeps streaming through it (the same genie-host pid, the same provider pid per agent,
 * every tick streamed while no window was open in the ledger, in order); "Shut down everything" ends window, host and
 * providers. It was run by hand on a test VM and by no gate: a proof nobody runs is not a proof. It is a row of both CI
 * scripts now, as plan-popover is (the CONTROL: a registered row is found by the same readings), on a home of its own.
 */
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split(/\r?\n/).join('\n');
const code = (text: string, comment: RegExp): string => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const linux = code(read('scripts/ci/linux.sh'), /^\s*#/);
const windows = code(read('scripts/ci/windows.ps1'), /^\s*#/);
const script = code(read('scripts/quit-keeps-host-cdp.mjs'), /^\s*(\/\/|\*|\/\*)/);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linuxRows = (): string[] => (/^ROWS=\(\n([\s\S]*?)\n\)/m.exec(linux)?.[1] ?? '').split(/\s+/).filter(Boolean);
const windowsRows = (): string[] => [...(/^\$Rows = @\(\n([\s\S]*?)\n\)/m.exec(windows)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
const linuxCeiling = (row: string): number | null => {
    const body = /^ceiling\(\) \{\n([\s\S]*?)\n\}/m.exec(linux)?.[1] ?? '';
    const m = new RegExp(`^\\s*(?:[a-z0-9-]+\\|)*${esc(row)}(?:\\|[a-z0-9-]+)*\\) echo (\\d+) ;;`, 'm').exec(body);
    return m ? Number(m[1]) : null;
};
const windowsCeiling = (row: string): number | null => {
    const body = /^function Ceiling\(\[string\]\$name\) \{\n([\s\S]*?)\n\}/m.exec(windows)?.[1] ?? '';
    const m = new RegExp(`^\\s*(?:'${esc(row)}'|\\{ \\$_ -in [^}]*'${esc(row)}'[^}]*\\}) \\{ return (\\d+) \\}`, 'm').exec(body);
    return m ? Number(m[1]) : null;
};
const reaped = (): string[] => (/case " ([a-z0-9 -]+) " in\n\s*\*" \$name "\*\) reap_leftovers/.exec(linux)?.[1] ?? '').split(' ');
/** A Windows row function's whole body, to its closing brace at the start of a line. */
const windowsRow = (row: string): string => new RegExp(`^function Row-${esc(row)} \\{\\n([\\s\\S]*?)\\n\\}$`, 'm').exec(windows)?.[1] ?? '';

describe('CONTROL: plan-popover, a registered row, is found by these readings', () => {
    it('is in both row lists, with a ceiling each, and reaped on Linux', () => {
        expect(linuxRows()).toContain('plan-popover');
        expect(windowsRows()).toContain('plan-popover');
        expect(linuxCeiling('plan-popover')).not.toBeNull();
        expect(windowsCeiling('plan-popover')).not.toBeNull();
        expect(reaped()).toContain('plan-popover');
    });
});

describe('quit-keeps-host is a row of scripts/ci/linux.sh', () => {
    const fn = /^row_quit-keeps-host\(\) \{ (.*) \}$/m.exec(linux)?.[1] ?? '';

    it('is in ROWS, and its leftovers are reaped before it starts', () => {
        expect(linuxRows()).toContain('quit-keeps-host');
        expect(reaped()).toContain('quit-keeps-host');
    });

    it('builds, needs the display, and runs the script on it under a timeout, on a home of its own, its ports its own, its proof under ci-out', () => {
        expect(fn).toMatch(/^need_build && need_display && on_display timeout \d+ env .*node scripts\/quit-keeps-host-cdp\.mjs$/);
        expect(fn).toContain('QUIT_CDP_OWN_HOME=1');
        expect(fn).toContain('QUIT_CDP_OUT="$OUT/quit-keeps-host"');
        // Not the shared app's 9222, nor Node's default inspector port.
        const port = Number(/CDP_PORT=(\d+)/.exec(fn)?.[1]);
        const inspect = Number(/QUIT_CDP_INSPECT=(\d+)/.exec(fn)?.[1]);
        expect(port).toBeGreaterThan(9300);
        expect(inspect).toBeGreaterThan(9300);
        expect(port).not.toBe(inspect);
    });

    it('its ceiling is above its timeout, and the timeout above the script\'s own watchdog and its 60 s cleanup', () => {
        const own = Number(/timeout (\d+) env/.exec(fn)?.[1]);
        const deadline = Number(/QUIT_CDP_DEADLINE_MS=(\d+)/.exec(fn)?.[1] ?? 360_000);
        expect(own).toBeGreaterThanOrEqual(deadline / 1000 + 60);
        expect(linuxCeiling('quit-keeps-host')!).toBeGreaterThan(own);
    });
});

describe('quit-keeps-host is a row of scripts/ci/windows.ps1', () => {
    const body = windowsRow('quit-keeps-host');

    it('is in $Rows, builds, needs a test machine, and runs the script on a home of its own, its ports its own, its proof under ci-out', () => {
        expect(windowsRows()).toContain('quit-keeps-host');
        expect(body).toMatch(/^\s*Need-Build; Need-TestMachine$/m);
        expect(body).toMatch(/QUIT_CDP_OWN_HOME = '1'/);
        expect(body).toMatch(/QUIT_CDP_OUT = \(Join-Path \$Out 'quit-keeps-host'\)/);
        expect(body).toMatch(/Run 'quit-keeps-host-cdp' \{ node scripts\/quit-keeps-host-cdp\.mjs \}/);
        // What it set for itself is put back, whatever the row's result.
        expect(body).toMatch(/\} finally \{/);
    });

    it('its ceiling is above the script\'s own watchdog and its 60 s cleanup', () => {
        const deadline = Number(/QUIT_CDP_DEADLINE_MS = '(\d+)'/.exec(body)?.[1]);
        expect(deadline).toBeGreaterThan(0);
        expect(windowsCeiling('quit-keeps-host')!).toBeGreaterThanOrEqual(deadline / 1000 + 90);
    });
});

describe('scripts/quit-keeps-host-cdp.mjs runs as a CI row', () => {
    it('CONTROL: it is the script that answers the quit "Just close the UI" and counts every tick', () => {
        expect(script).toContain("'Just close the UI'");
        expect(script).toMatch(/every tick streamed while no window was open is in the ledger, in order/);
    });

    it('takes the harness\'s word for a test machine (GENIE_TEST_MACHINE=1), and still refuses anywhere else', () => {
        expect(script).toMatch(/process\.env\.GENIE_TEST_MACHINE === '1'/);
        expect(script).toMatch(/if \(!testMachine\) refuse\(/);
    });

    it('on QUIT_CDP_OWN_HOME=1 seeds a NEW home with smoke-seed.mjs before any Genie path is read from it', () => {
        expect(script).toMatch(/process\.env\.QUIT_CDP_OWN_HOME === '1'/);
        expect(script).toMatch(/spawnSync\(process\.execPath, \[resolve\('scripts', 'smoke-seed\.mjs'\)\], \{ cwd: workspace,/);
        // The seeded workspace is a fresh directory in that home, never the checkout (whose project.json a Genie writes).
        expect(script).toMatch(/const workspace = join\(root, 'workspace'\);/);
        // The Genie paths are read AFTER the home is moved.
        expect(script.indexOf('ownHome()')).toBeGreaterThan(-1);
        expect(script.indexOf('ownHome()')).toBeLessThan(script.indexOf('const GENIE_HOME ='));
    });

    it('waits for the window process through the agents\' shutdown drain, the product\'s own figure, plus 60 s', () => {
        // The ticker agents are mid-turn for ever: "Shut down everything" waits the drain out before it stops them (the first
        // Azure run: a 60 s bound failed 26-28 while the lifecycle log said "(120-second wait expired)" and then shut down).
        const product = Number((/export const AGENT_DRAIN_WAIT_MS = ([\d_]+);/.exec(read('src/core/agent-shutdown-drain.ts'))?.[1] ?? 'NaN').replace(/_/g, ''));
        const mirrored = Number((/^const AGENT_DRAIN_WAIT_MS = ([\d_]+);/m.exec(script)?.[1] ?? 'NaN').replace(/_/g, ''));
        expect(product).toBeGreaterThan(0);
        expect(mirrored).toBe(product);
        expect(script).toMatch(/const exit = await exitWithin\(a\.app, AGENT_DRAIN_WAIT_MS \+ 60_000\);/);
    });

    it('attaches to Genie\'s MAIN window (never the host-wait window that opens first), through the shared picker', () => {
        expect(script).toMatch(/from '\.\/cdp-main-window\.mjs'/);
        expect(script).toMatch(/mainWindow\(targets\)/);
    });

    it('starts Electron by its own path, never through npx (a moved home has no npm cache or trusted shim)', () => {
        expect(script).not.toMatch(/'npx'|npx\.cmd/);
        expect(script).toMatch(/createRequire\(import\.meta\.url\)\('electron'\)/);
    });

    it('on Windows ends its run through scripts/end-own-tree.mjs (Tynn #1031) and fails on anything it leaves', () => {
        expect(script).toMatch(/import\('\.\/end-own-tree\.mjs'\)/);
        expect(script).toMatch(/endOwnRun\(\{/);
        expect(script).toMatch(/nothing of this run is left running by its own cleanup/);
    });
});
