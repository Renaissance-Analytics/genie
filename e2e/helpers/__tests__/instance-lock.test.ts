import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    awaitInstanceExit,
    awaitPidExit,
    clearInstanceRecord,
    processImageName,
    readInstanceRecord,
    writeInstanceRecord,
    type InstanceRecord,
} from '../instance-lock';

/**
 * The wait-for-exit that stands between one E2E Electron instance and the next
 * (genie#369).
 *
 * Why this is unit-tested rather than only exercised by the suite it guards: the
 * condition it exists for — a launch beginning while the previous app is still
 * on its way out — is exactly the condition that does NOT occur on an idle
 * machine, which is every developer's. A test that launches an app and watches
 * it succeed passes whether the wait works or not. So the wait is tested here
 * against REAL processes whose exit time this file chooses.
 */

const made: string[] = [];
const children: Array<{ kill: () => void }> = [];

function recordFile(): string {
    const f = path.join(
        os.tmpdir(),
        `genie-e2e-lock-test-${process.pid}-${made.length}-${Date.now()}.json`,
    );
    made.push(f);
    return f;
}

/** A real OS process that exits on its own after `ms`. */
function spawnFor(ms: number): { pid: number; image: string } {
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], {
        stdio: 'ignore',
    });
    children.push({ kill: () => child.kill('SIGKILL') });
    if (!child.pid) throw new Error('child never got a pid');
    const image = processImageName(child.pid);
    if (!image) throw new Error(`child ${child.pid} was not running when spawned`);
    return { pid: child.pid, image };
}

function record(over: Partial<InstanceRecord> & { pid: number; image: string }): InstanceRecord {
    return { harness: 'master', startedAt: Date.now(), ...over };
}

afterEach(() => {
    for (const c of children.splice(0)) c.kill();
    for (const f of made.splice(0)) fs.rmSync(f, { force: true });
});

describe('processImageName', () => {
    it('names a running process and returns null for one that is gone', () => {
        expect(processImageName(process.pid)).toMatch(/node/i);

        // The same pid, before and after: naming a live process proves the lookup
        // works, and the SAME pid reading null once killed proves the null is the
        // process being gone rather than the lookup simply never finding anything.
        const live = spawnFor(30_000);
        expect(processImageName(live.pid)).toMatch(/node/i);
        process.kill(live.pid, 'SIGKILL');

        const deadline = Date.now() + 10_000;
        let name = processImageName(live.pid);
        while (name && Date.now() < deadline) name = processImageName(live.pid);
        expect(name).toBeNull();
    });
});

describe('the instance record', () => {
    it('round-trips, and reads back null once cleared', () => {
        const f = recordFile();
        expect(readInstanceRecord(f)).toBeNull();
        const rec = record({ pid: 4242, image: 'electron.exe' });
        writeInstanceRecord(f, rec);
        expect(readInstanceRecord(f)).toEqual(rec);
        clearInstanceRecord(f);
        expect(readInstanceRecord(f)).toBeNull();
    });

    it('survives a corrupt file rather than throwing at launch', () => {
        const f = recordFile();
        fs.writeFileSync(f, 'not json {{{');
        expect(readInstanceRecord(f)).toBeNull();
    });
});

describe('awaitInstanceExit', () => {
    it('returns at once when nothing was ever recorded', async () => {
        const started = Date.now();
        await awaitInstanceExit(recordFile(), { timeoutMs: 5_000 });
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('WAITS for a recorded process that is still alive, and returns once it is gone', async () => {
        const f = recordFile();
        // The child outlives the test on its own and is killed on a timer THIS
        // test starts, so the two clocks are independent: a child given a fixed
        // lifetime would have spent part of it inside the setup's identity probe,
        // and the wait would then look shorter than it was.
        const live = spawnFor(60_000);
        writeInstanceRecord(f, record(live));
        const killAfter = 1_200;
        const timer = setTimeout(() => {
            try {
                process.kill(live.pid, 'SIGKILL');
            } catch {
                /* already gone */
            }
        }, killAfter);

        const started = Date.now();
        await awaitInstanceExit(f, { timeoutMs: 20_000, pollMs: 50 });
        const waited = Date.now() - started;
        clearTimeout(timer);

        // It must have actually waited — not merely returned and left the process up.
        expect(waited).toBeGreaterThan(1_000);
        expect(processImageName(live.pid)).toBeNull();
        // ...and it clears the record it consumed, so the next launch is not
        // charged for an instance that has already been proven gone.
        expect(readInstanceRecord(f)).toBeNull();
    });

    it('throws NAMING the instance when it outlives the bound, instead of hanging', async () => {
        const f = recordFile();
        const stuck = spawnFor(60_000);
        writeInstanceRecord(f, record({ ...stuck, harness: 'master' }));

        await expect(awaitInstanceExit(f, { timeoutMs: 700, pollMs: 50 })).rejects.toThrow(
            new RegExp(String(stuck.pid)),
        );
        await expect(awaitInstanceExit(f, { timeoutMs: 700, pollMs: 50 })).rejects.toThrow(
            /master/,
        );

        // POSITIVE CONTROL for the throw above: the same record, the same live
        // process — given a bound long enough to cover its exit, this RESOLVES.
        // Without this, "it throws" would also pass against a helper that threw
        // unconditionally.
        stuck.pid && process.kill(stuck.pid);
        await awaitInstanceExit(f, { timeoutMs: 20_000, pollMs: 50 });
        expect(readInstanceRecord(f)).toBeNull();
    });

    it('treats a REUSED pid as gone — a record must not strand a launch behind a stranger', async () => {
        const f = recordFile();
        // This pid is alive, but it is not the image we recorded: exactly what a
        // pid the OS handed to something else after our app died looks like.
        writeInstanceRecord(f, record({ pid: process.pid, image: 'electron-that-never-was.exe' }));

        const started = Date.now();
        await awaitInstanceExit(f, { timeoutMs: 20_000, pollMs: 50 });
        // Stated well inside the BOUND rather than as a bare stopwatch figure:
        // what matters is that it gave up on the stranger instead of waiting the
        // budget out. (The identity probe is one `tasklist`/`ps`, itself a good
        // fraction of a second on Windows, so a sub-second figure would be
        // measuring the OS rather than this helper.)
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(readInstanceRecord(f)).toBeNull();
    });

    it('awaitPidExit waits for one named process and throws if it outlives the bound', async () => {
        // Teardown's half of the same guarantee: it takes a pid rather than a
        // record, so it needs its own coverage of both outcomes.
        const stuck = spawnFor(60_000);
        await expect(awaitPidExit(stuck.pid, stuck.image, { timeoutMs: 700, pollMs: 50 })).rejects
            .toThrow(new RegExp(String(stuck.pid)));

        // POSITIVE CONTROL: the same pid, the same image, once it has actually
        // gone — this RESOLVES, so the rejection above is the process being alive
        // and not the helper rejecting whatever it is handed.
        process.kill(stuck.pid, 'SIGKILL');
        await awaitPidExit(stuck.pid, stuck.image, { timeoutMs: 20_000, pollMs: 50 });

        // ...and a live pid under a DIFFERENT image is somebody else's: return.
        await awaitPidExit(process.pid, 'electron-that-never-was.exe', {
            timeoutMs: 20_000,
            pollMs: 50,
        });
    });

    it('POSITIVE CONTROL for pid reuse: the SAME live pid under its REAL image is waited for', async () => {
        const f = recordFile();
        writeInstanceRecord(f, record({ pid: process.pid, image: processImageName(process.pid)! }));
        // This process is not going to exit, so the wait must hit its bound —
        // proving the reuse case above returned early because the IMAGE differed,
        // not because a live pid is ignored.
        await expect(awaitInstanceExit(f, { timeoutMs: 700, pollMs: 50 })).rejects.toThrow(
            /still running/i,
        );
    });
});
