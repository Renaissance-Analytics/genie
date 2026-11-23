import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { endOwnTree, parseProcessTable, treeOf, type EndPorts, type ProcessRow } from '../scripts/end-own-tree.mjs';

/**
 * A ROW ENDS WHAT IT STARTED, AND SAYS SO (Tynn #1031, genie#2147). Two Windows gates failed `local-door` with every check
 * passing, on "LEFT RUNNING after the row":
 *
 *   - 1123-070157-9d5293: `electron … --updater` (pid 1152). genie-host is not in the app's process tree and its updater
 *     helper is detached from it, so nothing in the row's cleanup ended the helper. It leaves by itself when the host's
 *     link closes (measured, queue item 1123-151458-c9e688, 11 of 11 runs: "updater: the host's link closed; leaving",
 *     58 to 78 ms before the row guard looked). The row never waited for it.
 *   - 1123-141923-9a7aa2: the row's own app (electron 7692, the row's argv). The cleanup ran `taskkill /T /F` with its
 *     answer thrown away and never looked whether the app had gone.
 *
 * So the cleanup is one helper for every row that starts its own Genie: it reads the process table BEFORE it ends
 * anything (the tree is only whole then), ends the app's tree with taskkill and keeps its answer, ends by pid whatever of
 * this run is still alive, and reads the table again until nothing of this run is in it, within a bound. What it had to
 * end after taskkill is named; what is still there at the bound fails the row. The row guard is untouched.
 */

const SINCE = 1_000_000;
const row = (pid: number, ppid: number, name: string, cmd = name, created = SINCE + pid): ProcessRow => ({ pid, ppid, created, name, cmd });

/** THE RUN'S SHAPE, as measured: the harness (1) started the app (10); the host (20) is NOT under the app; its spawn host (21) started the helper (22). */
const run = (): ProcessRow[] => [
    row(1, 0, 'node.exe', 'node scripts/local-door-cdp.mjs'),
    row(10, 1, 'electron.exe', 'electron.exe . --remote-debugging-port=9334'),
    row(11, 10, 'electron.exe', 'electron.exe --type=gpu-process'),
    row(12, 10, 'electron.exe', 'electron.exe --type=renderer'),
    row(20, 900, 'electron.exe', 'electron.exe genie-host'),
    row(21, 20, 'electron.exe', 'electron.exe spawn-host supervised'),
    row(22, 21, 'electron.exe', 'electron.exe D:\\genie\\work\\x --updater'),
    // Not this run's: another Genie's window on the machine, and a system process far older than the run.
    row(50, 4, 'electron.exe', 'electron.exe someone-elses'),
    row(60, 4, 'svchost.exe', 'svchost.exe', 5),
];

/** A machine for the helper to act on: a process table, a clock that only the helper's own waits and reads move. */
function world(rows: ProcessRow[], opts: { taskkill?: (pid: number, w: World) => { status: number | null; out: string; err: string }; killTakesMs?: (pid: number) => number; immortal?: number[]; tableMs?: number } = {}) {
    const w: World = { rows: new Map(rows.map((r) => [r.pid, r])), now: 5_000_000, dying: new Map(), killed: [], taskkilled: [], lines: [], reads: 0 };
    const settle = (): void => { for (const [pid, at] of [...w.dying]) if (w.now >= at) { w.rows.delete(pid); w.dying.delete(pid); } };
    const die = (pid: number): void => { if (w.rows.has(pid) && !opts.immortal?.includes(pid) && !w.dying.has(pid)) w.dying.set(pid, w.now + (opts.killTakesMs?.(pid) ?? 0)); settle(); };
    const tree = (pid: number): number[] => [pid, ...[...w.rows.values()].filter((r) => r.ppid === pid).flatMap((r) => tree(r.pid))];
    const ports: EndPorts = {
        table: async () => { w.reads += 1; w.now += opts.tableMs ?? 400; settle(); return [...w.rows.values()]; },
        taskkillTree: (pid) => {
            w.taskkilled.push(pid);
            const custom = opts.taskkill?.(pid, w);
            if (custom) return { ...custom, ms: 80 };
            const ended = tree(pid).filter((p) => w.rows.has(p));
            for (const p of ended) die(p);
            return { status: 0, out: ended.map((p) => `SUCCESS: The process with PID ${p} (child process of PID ${w.rows.get(p)?.ppid ?? 0}) has been terminated.`).join('\r\n'), err: '', ms: 80 };
        },
        kill: (pid) => { w.killed.push(pid); die(pid); },
        alive: (pid) => { settle(); return w.rows.has(pid); },
        sleep: async (ms) => { w.now += ms; settle(); },
        now: () => w.now,
        log: (line) => { w.lines.push(line); },
    };
    return { w, ports, die };
}
interface World { rows: Map<number, ProcessRow>; now: number; dying: Map<number, number>; killed: number[]; taskkilled: number[]; lines: string[]; reads: number }
const roots = [{ pid: 10, what: 'the app' }, { pid: 20, what: 'genie-host' }];

describe('the process table, as PowerShell prints it for this helper', () => {
    it('one process per line: pid|parent|created ms|name|command line, the command line kept whole', () => {
        const text = '10|1|1700000000123|electron.exe|electron.exe . --flag="a|b"\r\n\r\n4|0|0|System|\r\nnot a row\r\n22|21|1700000000999|electron.exe|electron.exe D:\\x --updater\r\n';
        expect(parseProcessTable(text)).toEqual([
            { pid: 10, ppid: 1, created: 1700000000123, name: 'electron.exe', cmd: 'electron.exe . --flag="a|b"' },
            { pid: 4, ppid: 0, created: 0, name: 'System', cmd: '' },
            { pid: 22, ppid: 21, created: 1700000000999, name: 'electron.exe', cmd: 'electron.exe D:\\x --updater' },
        ]);
    });
});

describe("this run's own processes, from the table", () => {
    it("GATE 9d5293's HELPER: the updater helper is found through the host and its spawn host, though the host is not under the app", () => {
        const own = treeOf(run(), [10, 20], SINCE);
        expect([...own.keys()].sort((a, b) => a - b)).toEqual([10, 11, 12, 20, 21, 22]);
    });

    it('from the app alone (what `taskkill /T` reaches) the host and its helper are NOT found: why the old cleanup left them', () => {
        expect([...treeOf(run(), [10], SINCE).keys()].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    });

    it("another Genie on the machine is never this run's, and neither is the harness itself", () => {
        const own = treeOf(run(), [10, 20], SINCE);
        expect(own.has(50)).toBe(false);
        expect(own.has(1)).toBe(false);
    });

    it('A REUSED PID IS NOT OURS: a process older than the run is never taken, as a root or as a child of one', () => {
        const rows = [row(10, 1, 'chrome.exe', 'chrome.exe', SINCE - 5_000), row(11, 10, 'chrome.exe', 'chrome.exe --type=renderer', SINCE - 4_000), row(20, 900, 'electron.exe', 'genie-host'), row(23, 20, 'old.exe', 'old.exe', SINCE - 1)];
        expect([...treeOf(rows, [10, 20], SINCE).keys()]).toEqual([20]);
    });

    it('a child whose parent has already gone from the table is still found, by the parent pid it was started with', () => {
        // The spawn host (21) died with the host; the helper's row still says its parent was 21, which an earlier read knew.
        const later = [row(22, 21, 'electron.exe', 'electron.exe D:\\x --updater')];
        expect([...treeOf(later, [10, 20, 21], SINCE).keys()]).toEqual([22]);
    });
});

describe('the cleanup ends the run and waits for it, within a bound', () => {
    it("GATE 9d5293: the helper outlives the app's tree kill; it is ended by pid, waited for, and the cleanup only returns once the table has none of the run", async () => {
        // The helper takes 300 ms to go after it is ended: longer than the 70 ms the old cleanup left before the guard.
        const { w, ports } = world(run(), { killTakesMs: (pid) => (pid === 22 ? 300 : 0) });
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(r.ok).toBe(true);
        expect(r.left).toEqual([]);
        expect(w.taskkilled).toEqual([10]);
        expect(w.killed).toEqual(expect.arrayContaining([20, 21, 22]));
        // Nothing of the run is in the table when it returns: what the row guard reads next.
        expect([...w.rows.keys()].sort((a, b) => a - b)).toEqual([1, 50, 60]);
        expect(w.lines.join('\n')).toMatch(/--updater/);
    });

    it("GATE 9a7aa2: taskkill answers an error and leaves the app; its status and words are in the log, the app is ended by pid and NAMED", async () => {
        const { w, ports } = world(run(), { taskkill: () => ({ status: 255, out: '', err: 'ERROR: The process with PID 10 (child process of PID 1) could not be terminated.\r\nReason: One or more child processes of this process were still running.' }) });
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(r.ok).toBe(true);
        expect(w.killed).toEqual(expect.arrayContaining([10, 11, 12]));
        const log = w.lines.join('\n');
        expect(log).toMatch(/taskkill \/T \/F \/PID 10: status 255/);
        expect(log).toMatch(/One or more child processes of this process were still running/);
        expect(log).toMatch(/taskkill left running[^\n]*\b10\b[^\n]*--remote-debugging-port=9334/);
        expect([...w.rows.keys()].sort((a, b) => a - b)).toEqual([1, 50, 60]);
    });

    it("taskkill's status and what it ended are in the log when it works, too", async () => {
        const { w, ports } = world(run());
        await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        const log = w.lines.join('\n');
        expect(log).toMatch(/taskkill \/T \/F \/PID 10: status 0 in 80 ms; ended 3 \(10 11 12\); no errors/);
        expect(log).not.toMatch(/taskkill left running/);
    });

    it('THE TIMING IS SAID: how many of the run there were, and how long until the table had none', async () => {
        const { w, ports } = world(run(), { killTakesMs: (pid) => (pid === 22 ? 300 : 0) });
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(w.lines.at(-1)).toMatch(/^shutdown: all 6 of this run's processes are gone, \d+ ms after the cleanup began \(\d+ process-table reads\)$/);
        expect(r.ms).toBeGreaterThanOrEqual(300);
        expect(r.ended).toBe(6);
    });

    it('STARTED DURING THE CLEANUP: a process the host started after the first read is found on the next read and ended', async () => {
        const { w, ports } = world(run());
        let added = false;
        const table = ports.table;
        ports.table = async () => { const rows = await table(); if (!added && w.reads === 1) { added = true; w.rows.set(30, row(30, 20, 'electron.exe', 'electron.exe late-child', SINCE + 9_000)); } return rows; };
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(r.ok).toBe(true);
        expect(w.killed).toContain(30);
        expect(w.rows.has(30)).toBe(false);
        expect(r.ended).toBe(7);
    });

    it('WHAT WILL NOT END FAILS THE ROW: still in the table at the bound, it is named and the answer is not ok', async () => {
        const { w, ports } = world(run(), { immortal: [22] });
        const before = w.now;
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, boundMs: 15_000, ports });
        expect(r.ok).toBe(false);
        expect(r.left.map((p) => p.pid)).toEqual([22]);
        expect(w.lines.at(-1)).toMatch(/^shutdown: STILL RUNNING after \d+ ms: electron\.exe 22 \(parent 21\) electron\.exe D:\\genie\\work\\x --updater$/);
        // Bounded: it gave up near the bound, not at once and not never.
        expect(w.now - before).toBeGreaterThanOrEqual(15_000);
        expect(w.now - before).toBeLessThan(20_000);
    });

    it("NEVER ANOTHER GENIE: a process that is not this run's is neither ended nor waited for", async () => {
        const { w, ports } = world(run());
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(r.ok).toBe(true);
        expect(w.killed).not.toContain(50);
        expect(w.killed).not.toContain(1);
        expect(w.rows.has(50)).toBe(true);
    });

    it('a run whose app and host have already gone ends nothing and says so', async () => {
        const { w, ports } = world([row(1, 0, 'node.exe'), row(50, 4, 'electron.exe', 'electron.exe someone-elses')]);
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(r.ok).toBe(true);
        expect(w.taskkilled).toEqual([]);
        expect(w.killed).toEqual([]);
        expect(w.lines.at(-1)).toMatch(/nothing of this run was running/);
    });

    it('a table that cannot be read is not "nothing running": the answer is not ok, and says why', async () => {
        const { w, ports } = world(run());
        ports.table = async () => { throw new Error('PowerShell took over 60 s'); };
        const r = await endOwnTree({ roots, treeRoot: 10, since: SINCE, ports });
        expect(r.ok).toBe(false);
        expect(w.lines.join('\n')).toMatch(/the process table could not be read: PowerShell took over 60 s/);
        // The app's tree is still ended the old way, so an unreadable table costs the verdict, not the cleanup.
        expect(w.taskkilled).toEqual([10]);
        expect(w.killed).toContain(20);
    });
});

describe('wired: every Windows row that starts its own Genie ends it through this helper', () => {
    const SCRIPTS = ['local-door-cdp', 'host-late-ready-cdp', 'gapp-open-cdp', 'plan-popover-cdp', 'trust-step-cdp', 'accounts-popover-cdp', 'claude-accounts-cdp', 'sound-picker-cdp', 'question-maximize-cdp'];
    for (const name of SCRIPTS) {
        it(`${name}: endOwnRun on Windows, no taskkill of its own, and a run that is left running fails`, () => {
            const source = readFileSync(`scripts/${name}.mjs`, 'utf8');
            expect(source).toMatch(/import \{[^}]*\bendOwnRun\b[^}]*\} from '\.\/end-own-tree\.mjs';/);
            expect(source).toMatch(/await endOwnRun\(/);
            // Comments aside, the script no longer calls taskkill itself: its answer was thrown away there.
            const code = source.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
            expect(code).not.toMatch(/['"]taskkill['"]/);
            expect(code).toMatch(/LEFT RUNNING by this row's own cleanup/);
        });
    }

    it('the packaged-launcher row ends its app and host through the same helper, and fails when it cannot', () => {
        const ps1 = readFileSync('scripts/ci/windows.ps1', 'utf8');
        const body = ps1.slice(ps1.indexOf('function Row-packaged-launcher'));
        // The function alone, to its closing brace: the comment block after it (the row ceilings) speaks of taskkill too.
        const fn = body.slice(0, body.search(/^\}\r?$/m));
        expect(fn).toMatch(/Start-Process -FilePath \(Resolve-Path "release\\win-unpacked\\Genie\.exe"\) -PassThru/);
        expect(fn).toMatch(/node scripts\/end-own-tree\.mjs/);
        expect(fn).not.toMatch(/taskkill/);
        expect(fn).toMatch(/left running by the row's own cleanup/);
    });

    it('THE ROW GUARD IS AS IT WAS: what is still running of Genie after a row fails the row', () => {
        const ps1 = readFileSync('scripts/ci/windows.ps1', 'utf8');
        expect(ps1).toMatch(/\$left = @\(Find-GenieLeftovers\)\r?\n\s+if \(\$left\.Count -gt 0\) \{/);
        expect(ps1).toMatch(/Add-Content -Path \$log -Value "LEFT RUNNING after the row: \$leftover"/);
        expect(ps1).toMatch(/Stop-GenieLeftovers \$left\r?\n\s+\$ok = \$false/);
        expect(ps1).toMatch(/@\(Get-Process -Name 'electron', 'Genie', 'genie-host', 'genie-launch' -ErrorAction SilentlyContinue\)/);
    });
});
