import { describe, expect, it } from 'vitest';
import { makeProcessTree, type ProcessTreeIo } from '../src/core/process-tree.js';

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

function fakeIo(tree: Record<number, number[]>) {
    const killed: number[] = [];
    let enumerateThrows = false;

    const descendants = (pid: number): number[] => {
        if (enumerateThrows) throw new Error('WMI unavailable');
        const out: number[] = [];
        const walk = (p: number): void => {
            for (const child of tree[p] ?? []) {
                if (!out.includes(child)) {
                    out.push(child);
                    walk(child);
                }
            }
        };
        walk(pid);
        return out;
    };

    const io: ProcessTreeIo = {
        descendants,
        killOne: (pid) => { killed.push(pid); },
    };

    return { io, killed, breakEnumeration: () => { enumerateThrows = true; } };
}

describe('reaping only what we own', () => {
    it('kills the pids it was given, when they really are ours', () => {
        // The ordinary case, and the positive control for everything below: a reaper that
        // refused everything would pass every safety test in this file and reap nothing.
        const { io, killed } = fakeIo({ 100: [200, 201], 200: [300] });
        const tree = makeProcessTree(io, () => 100);

        tree.killTree([200, 201, 300]);

        expect(killed.sort()).toEqual([200, 201, 300]);
    });

    it('REFUSES a pid that is no longer our descendant', () => {
        /**
         * The pid was ours when it was recorded and is not ours now — it exited and Windows
         * handed its number to something else. Killing it would kill a stranger, and on this
         * machine a stranger is another agent's work.
         */
        const { io, killed } = fakeIo({ 100: [200] });
        const tree = makeProcessTree(io, () => 100);

        tree.killTree([200, 999]);

        expect(killed).toEqual([200]);
    });

    it('kills NOTHING when the enumeration fails', () => {
        /**
         * A walk that cannot run reports nothing, and nothing must never be read as "kill
         * everything". The read-only side already treats an empty result as unverified rather
         * than as proof a stop worked; this is the same rule on the destructive side.
         */
        const { io, killed, breakEnumeration } = fakeIo({ 100: [200] });
        const tree = makeProcessTree(io, () => 100);
        breakEnumeration();

        tree.killTree([200]);

        expect(killed).toEqual([]);
    });

    it('REFUSES an implausibly large reap rather than attempting it', () => {
        /**
         * The blast-radius cap, and the one that would have saved the owner's morning.
         *
         * A session that spawned one provider asks to reap a handful of pids. If the walk says
         * our subtree contains dozens, the walk is wrong — a recycled parent pointer has
         * grafted somebody else's tree onto ours. That is precisely when killing is most
         * destructive and least needed, so it does not happen.
         */
        const many = Array.from({ length: 60 }, (_, i) => 500 + i);
        const { io, killed } = fakeIo({ 100: many });
        const tree = makeProcessTree(io, () => 100);

        const result = tree.killTree(many);

        expect(killed).toEqual([]);
        expect(result.refused).toBe(true);
        expect(result.reason).toContain('60');
    });

    it('still reaps a normal provider tree, which is what the cap must not break', () => {
        // POSITIVE CONTROL for the cap. The measured real case is nine provider processes —
        // well inside it. A cap that also refused this would have quietly disabled the reaper.
        const nine = [201, 202, 203, 204, 205, 206, 207, 208, 209];
        const { io, killed } = fakeIo({ 100: nine });
        const tree = makeProcessTree(io, () => 100);

        const result = tree.killTree(nine);

        expect(result.refused).toBe(false);
        expect(killed.sort()).toEqual(nine.sort());
    });

    it('reports what it did, so a stop can say whether it was verified', () => {
        // `stop()` must be able to distinguish "reaped three" from "reaped nothing because the
        // scan failed". Returning a count is what lets it tell the truth about itself.
        const { io } = fakeIo({ 100: [200, 201] });
        const tree = makeProcessTree(io, () => 100);

        expect(tree.killTree([200, 201])).toMatchObject({ refused: false, killed: 2 });
    });

    it('is a no-op for an empty list, without enumerating at all', () => {
        // A session that recorded no pids of its own — the common case, since the driver
        // normally reaps everything itself — must not trigger a machine-wide process walk on
        // every stop. That walk shells out to PowerShell.
        let walks = 0;
        const io: ProcessTreeIo = {
            descendants: () => { walks += 1; return []; },
            killOne: () => {},
        };
        const tree = makeProcessTree(io, () => 100);

        tree.killTree([]);

        expect(walks).toBe(0);
    });
});

describe('the read-only instrument', () => {
    it('reports our descendants at any depth', () => {
        const { io } = fakeIo({ 100: [200], 200: [300], 300: [400] });
        const tree = makeProcessTree(io, () => 100);

        expect([...tree.descendantsOf(100)].sort()).toEqual([200, 300, 400]);
    });

    it('reports NOTHING when it cannot look, rather than claiming an empty machine', () => {
        // The caller must not read this as "the stop worked". `stop()` treats an empty reap as
        // unverified, which is the only honest reading.
        const { io, breakEnumeration } = fakeIo({ 100: [200] });
        const tree = makeProcessTree(io, () => 100);
        breakEnumeration();

        expect(tree.descendantsOf(100)).toEqual([]);
    });
});
