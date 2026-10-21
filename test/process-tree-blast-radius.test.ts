import { describe, expect, it } from 'vitest';
import { makeProcessTree, subtreeOf, type ProcessInfo, type ProcessTreeIo } from '../src/core/process-tree.js';

/**
 * THE REAPER MUST NOT BE ABLE TO KILL SOMETHING IT DOES NOT OWN.
 *
 * ## The incident this file exists for
 *
 * 2026-10-10, 06:14 local. `npm run verify:resume` — a live check that spawns a real provider
 * and reaps it — ran on the OWNER'S DESKTOP. Six minutes later Genie's host service wrote its
 * last log line and stayed down for four and a half hours, taking the terminal the work was
 * running in with it. The owner woke up to unfinished work and a dead terminal.
 *
 * Not proven, and there is no kill record — the log just stops mid-stream. But the reap is the
 * only thing in that window that kills processes by enumeration, and the correlation is not
 * something to argue away.
 *
 * ## The mechanism, which is a property of Windows and not a bug in the walk
 *
 * `win32Descendants` walks WMI `ParentProcessId`. **Windows recycles pids**, and a process
 * whose parent has exited keeps a parent pointer that can now name a DIFFERENT, live process.
 * So the walk can legitimately return processes that were never ours. `taskkill /T` then took
 * each one's whole tree.
 *
 * Re-enumerating does not fix that: the bad pointer is in the data, so a second walk agrees
 * with the first. **The enumeration cannot be made trustworthy, so the blast radius has to be
 * bounded instead.**
 *
 * ## What bounds it
 *
 *  1. **No `/T`.** Every genuine descendant is already in the set, so expanding each kill into
 *     a tree only adds processes nobody verified.
 *  2. **A plausibility cap.** A session that started ONE provider cannot reap forty processes.
 *     When the count exceeds what the caller claims to own by a wide margin, the reap is
 *     REFUSED and reported rather than attempted — an over-broad enumeration is exactly the
 *     case where killing is most dangerous and least necessary.
 *  3. **Never on an enumeration failure.** A walk that cannot run reports nothing, and nothing
 *     must never be read as "kill everything".
 *
 * And the reason this is safe to tighten at all: the file's own measurement says
 * `driver.kill('SIGTERM')` already terminated all nine provider processes, with the descendant
 * count returning exactly to baseline. The reaper is defence in depth. **A defence that can
 * kill the machine's agent host is worse than the leak it defends against.**
 *
 * Every test here injects the OS calls. Nothing spawns, nothing is killed, and this suite can
 * run anywhere — which is the other half of the lesson.
 */

/** pid -> parent, with start times in creation order; a pid listed under a parent started after it. */
function fakeIo(tree: Record<number, number[]>) {
    const killed: number[] = [];
    let snapshotThrows = false;
    let snapshots = 0;
    let clock = 0;
    const rows: ProcessInfo[] = [{ pid: 100, ppid: 1, started: clock++, name: 'Genie.exe' }];
    const add = (parent: number): void => {
        for (const child of tree[parent] ?? []) {
            if (rows.some((r) => r.pid === child)) continue;
            rows.push({ pid: child, ppid: parent, started: clock++, name: 'proc' });
            add(child);
        }
    };
    add(100);
    const io: ProcessTreeIo = {
        snapshot: () => { snapshots += 1; if (snapshotThrows) throw new Error('WMI unavailable'); return [...rows]; },
        killOne: (pid) => { killed.push(pid); },
    };
    const row = (pid: number): ProcessInfo => rows.find((r) => r.pid === pid) ?? { pid, ppid: 100, started: 999, name: 'proc' };
    return { io, killed, row, rows, snapshots: () => snapshots, breakSnapshot: () => { snapshotThrows = true; } };
}

describe('reaping only what we own', () => {
    it('kills the processes it was given, when the reading shows they really are them', () => {
        // The positive control for everything below: a reaper that refused everything would pass every safety test.
        const { io, killed, row, rows } = fakeIo({ 100: [200, 201], 200: [300] });
        const tree = makeProcessTree(io);

        tree.killTree([200, 201, 300].map(row), rows);

        expect(killed.sort()).toEqual([200, 201, 300]);
    });

    it('REFUSES a process that is not in the reading, or is a different process under the same pid', () => {
        /**
         * The pid was ours when it was recorded and is not ours now — it exited and Windows handed its number to
         * something else. Killing it would kill a stranger, and on this machine a stranger is another agent's work.
         */
        const { io, killed, row, rows } = fakeIo({ 100: [200, 201] });
        const tree = makeProcessTree(io);

        tree.killTree([row(200), row(999), { ...row(201), started: row(201).started + 7 }], rows);

        expect(killed).toEqual([200]);
    });

    it('a reading that could not be taken is `null`, never an empty machine', () => {
        const { io, breakSnapshot } = fakeIo({ 100: [200] });
        const tree = makeProcessTree(io);
        breakSnapshot();

        expect(tree.snapshot()).toBeNull();
    });

    it('REFUSES an implausibly large reap rather than attempting it', () => {
        /**
         * The blast-radius cap — on what ONE session asks to reap, never on how many processes the machine has. A
         * session that spawned one provider asks for a handful of pids; dozens means the tree under it is not what it
         * seems, and that is precisely when killing is most destructive and least needed.
         */
        const many = Array.from({ length: 60 }, (_, i) => 500 + i);
        const { io, killed, row, rows } = fakeIo({ 100: many });
        const tree = makeProcessTree(io);

        const result = tree.killTree(many.map(row), rows);

        expect(killed).toEqual([]);
        expect(result.refused).toBe(true);
        expect(result.reason).toContain('60');
    });

    it('still reaps a normal provider tree, which is what the cap must not break', () => {
        // POSITIVE CONTROL for the cap. The measured real case is nine provider processes — well inside it.
        const nine = [201, 202, 203, 204, 205, 206, 207, 208, 209];
        const { io, killed, row, rows } = fakeIo({ 100: nine });
        const tree = makeProcessTree(io);

        const result = tree.killTree(nine.map(row), rows);

        expect(result.refused).toBe(false);
        expect(killed.sort()).toEqual(nine.sort());
    });

    it('is a no-op for an empty list, without reading the machine', () => {
        const { io, snapshots, rows } = fakeIo({ 100: [200] });
        const tree = makeProcessTree(io);

        expect(tree.killTree([], rows)).toEqual({ killed: 0, refused: false });
        expect(snapshots()).toBe(0);
    });
});

describe('the subtree of a process, from one reading', () => {
    it('reports every descendant at any depth', () => {
        const { row, rows } = fakeIo({ 100: [200], 200: [300], 300: [400] });
        expect(subtreeOf(rows, [row(200)]).map((p) => p.pid)).toEqual([200, 300, 400]);
    });

    it('never grafts on a process that started BEFORE its claimed parent (a recycled parent pointer)', () => {
        /**
         * The incident at the top of this file: Windows recycles pids, so a process whose parent exited keeps a pointer
         * that can now name a different, LIVE process. A child cannot have started before its parent; one that did is
         * somebody else's, whatever its pointer says.
         */
        const { row, rows } = fakeIo({ 100: [200] });
        const grafted: ProcessInfo = { pid: 777, ppid: 200, started: -5, name: 'svchost.exe' };
        expect(subtreeOf([...rows, grafted], [row(200)]).map((p) => p.pid)).toEqual([200]);
    });

    it('a root that is not in the reading as the same process has no subtree', () => {
        const { row, rows } = fakeIo({ 100: [200], 200: [300] });
        expect(subtreeOf(rows, [{ ...row(200), started: 12345 }])).toEqual([]);
    });
});

describe('reading the machine', () => {
    it('Windows: one Get-CimInstance listing, the scan’s own PowerShell (and what it started) left out', async () => {
        const { parseWin32Snapshot } = await import('../src/core/process-tree.js');
        const out = ['self|500', '100|1|1000|Genie.exe', '200|100|1100|cmd.exe', '500|100|1200|powershell.exe', '501|500|1201|conhost.exe', '', 'garbage'].join('\r\n');
        expect(parseWin32Snapshot(out, 100).map((p) => p.pid)).toEqual([100, 200]);
        expect(parseWin32Snapshot(out, 100)[1]).toEqual({ pid: 200, ppid: 100, started: 1100, name: 'cmd.exe' });
    });

    it('a listing without Genie itself in it is not a reading (it throws, and the tree answers null)', async () => {
        const { parseWin32Snapshot, parsePosixSnapshot } = await import('../src/core/process-tree.js');
        expect(() => parseWin32Snapshot('self|5\r\n7|1|1|x.exe', 100)).toThrow();
        expect(() => parsePosixSnapshot('    7     1 Tue Oct 20 12:00:00 2026 sleep\n', 100)).toThrow();
    });

    it('Linux/macOS: `ps -A -o pid=,ppid=,lstart=,comm=`, start time to the second, its own `ps` left out', async () => {
        const { parsePosixSnapshot } = await import('../src/core/process-tree.js');
        const out = [
            '  100     1 Tue Oct 20 12:00:00 2026 electron',
            '  200   100 Mon Oct  5 09:03:07 2026 claude',
            '  300   100 Tue Oct 20 12:00:09 2026 ps',
            '  400   200 Tue Oct 20 12:00:01 2026 /usr/bin/node',
        ].join('\n');
        const rows = parsePosixSnapshot(out, 100);
        expect(rows.map((p) => p.pid)).toEqual([100, 200, 400]);
        expect(rows[1]!.name).toBe('claude');
        expect(rows[1]!.started).toBe(new Date(2026, 9, 5, 9, 3, 7).getTime());
        expect(rows[2]!.started - rows[0]!.started).toBe(1_000);
    });
});
