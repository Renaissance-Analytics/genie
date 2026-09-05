/**
 * A launch must not begin while the PREVIOUS Genie is still on its way out
 * (genie#369).
 *
 * `playwright.config.ts` runs the suite serial + single-worker, and used to argue
 * from that that overlap was impossible. Serial only guarantees that one spec
 * finishes before the next STARTS — it says nothing about whether the app that
 * spec launched has actually exited.
 *
 * The gap is NOT `app.close()`, which was the obvious suspect and is innocent:
 * measured on Windows, it returns only once the Electron main and its wrapper are
 * both gone (511ms, both dead the instant it returned). A spec that closes its
 * app in `afterAll` leaks nothing.
 *
 * The gap is the teardown that never runs. Playwright STOPS THE WORKER after a
 * failed test and starts a fresh one, which re-runs the next spec's `beforeAll`
 * and launches again — with no `afterAll` in between to close anything, and from
 * a NEW PROCESS that remembers nothing about what the old one started. That is
 * why this record lives in a FILE: it is the only thing that can carry "an app
 * was launched and never proven dead" across a worker boundary.
 *
 * What overlap actually costs, measured on this machine (Windows, two `master`
 * instances against one `--user-data-dir`): the second app still opens a window,
 * but takes 10.3s instead of 3.2s — a 3x tax on a 30s budget. It is a slow
 * poisoning rather than an instant kill, which is exactly why it has read as
 * "a slow runner" every time it was triaged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface InstanceRecord {
    /** The Electron MAIN process id, as Playwright reported it at launch. */
    pid: number;
    /**
     * The process's image name at launch (`electron.exe`, `Electron`, …).
     *
     * Purely a guard against PID REUSE. A record is only left behind when a
     * worker is killed before it can prove the exit, and by the time the next
     * launch reads it the OS may well have handed that number to something
     * unrelated — at which point waiting for it to exit would strand the suite
     * behind a stranger for the whole budget and then fail a run that was fine.
     */
    image: string;
    /** Which harness page it was launched for — named in the failure message. */
    harness: string;
    /** Epoch ms, so a failure can say how long the thing has been hanging around. */
    startedAt: number;
}

export interface WaitOptions {
    /**
     * How long to wait before giving up. Bounded deliberately: a suite that hangs
     * here is worse than one that fails, because nothing says why. The default is
     * enormous next to a normal Genie shutdown (well under a second) and still
     * inside Playwright's 60s hook timeout, so the error below is what a spec
     * reports rather than the hook timing out around it and hiding the cause.
     */
    timeoutMs?: number;
    pollMs?: number;
}

/** Where the cross-process record lives. One suite, one file. */
export function instanceRecordPath(): string {
    return path.join(os.tmpdir(), 'genie-e2e-instance.json');
}

/**
 * The image name of `pid`, or null when nothing is running under it.
 *
 * `process.kill(pid, 0)` alone answers "is something alive", which is not the
 * question — after a reuse the answer is yes and it is the wrong process. This
 * probe costs one `tasklist`/`ps`, so it is used to DECIDE whether to wait, never
 * inside the poll loop.
 */
export function processImageName(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('tasklist', ['/NH', '/FI', `PID eq ${pid}`], {
                encoding: 'utf8',
                windowsHide: true,
            });
            if (/No tasks/i.test(out)) return null;
            const name = out.trim().split(/\s{2,}/)[0]?.trim();
            return name || null;
        }
        const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
            encoding: 'utf8',
        });
        const name = out.trim().split('\n')[0]?.trim();
        return name ? path.basename(name) : null;
    } catch {
        // A non-zero exit is how both tools say "no such pid".
        return null;
    }
}

/** Cheap "is anything alive under this pid" — no subprocess. */
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM means it exists and belongs to somebody else; only ESRCH is gone.
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * True while `rec`'s process is both alive AND still the process we launched.
 *
 * The cheap probe gates the expensive one deliberately. The overwhelmingly
 * common case is a previous instance that exited cleanly, where the pid is gone
 * and `kill(pid, 0)` settles it for free — a `tasklist` costs the better part of
 * a second on Windows, and paying that on every launch would tax the whole suite
 * to answer a question only a leaked process can raise.
 */
export function isRecordedInstanceRunning(rec: InstanceRecord): boolean {
    if (!pidAlive(rec.pid)) return false;
    const image = processImageName(rec.pid);
    if (!image) return false;
    return image.toLowerCase() === rec.image.toLowerCase();
}

export function writeInstanceRecord(file: string, rec: InstanceRecord): void {
    try {
        fs.writeFileSync(file, JSON.stringify(rec));
    } catch {
        // A record we cannot write only costs us the wait; it must never be the
        // reason a launch fails.
    }
}

export function readInstanceRecord(file: string): InstanceRecord | null {
    try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceRecord;
        return typeof rec?.pid === 'number' && typeof rec?.image === 'string' ? rec : null;
    } catch {
        // Missing is the normal case; corrupt (a worker killed mid-write) must
        // read the same way rather than throwing inside someone's beforeAll.
        return null;
    }
}

/** Drop the record. `onlyPid` keeps one launch from clearing another's. */
export function clearInstanceRecord(file: string, onlyPid?: number): void {
    if (onlyPid !== undefined) {
        const rec = readInstanceRecord(file);
        if (rec && rec.pid !== onlyPid) return;
    }
    try {
        fs.rmSync(file, { force: true });
    } catch {
        /* nothing left to clear */
    }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function describeRecord(rec: InstanceRecord): string {
    const age = Math.round((Date.now() - rec.startedAt) / 1000);
    return `pid ${rec.pid} (${rec.image}), launched for harness "${rec.harness}" ${age}s ago`;
}

/**
 * Block until the recorded instance is really gone, then clear the record.
 *
 * Resolves at once when there is nothing recorded, when the recorded process has
 * already exited, or when the pid now belongs to something else. Throws — never
 * hangs — when a genuine previous instance outlives the budget.
 */
export async function awaitInstanceExit(file: string, opts: WaitOptions = {}): Promise<void> {
    const { timeoutMs = 30_000, pollMs = 100 } = opts;
    const rec = readInstanceRecord(file);
    if (!rec) return;

    if (!isRecordedInstanceRunning(rec)) {
        clearInstanceRecord(file, rec.pid);
        return;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(pollMs);
        // The cheap probe inside the loop: once the pid is established as OURS,
        // its disappearance is all we are waiting for. Via `pidAlive` rather than
        // a bare `kill(pid, 0)` in a try/catch — that reads EPERM ("alive, and
        // not yours") as gone, which is the one wrong answer here, since it would
        // wave through a launch on top of a process that is still running.
        if (!pidAlive(rec.pid)) {
            clearInstanceRecord(file, rec.pid);
            return;
        }
    }

    // One last look under the expensive probe: a pid that died and was reused
    // mid-wait is not a reason to fail a run.
    if (!isRecordedInstanceRunning(rec)) {
        clearInstanceRecord(file, rec.pid);
        return;
    }

    throw new Error(
        `genie E2E: the previous Electron instance is STILL RUNNING after ${timeoutMs}ms — ` +
            `${describeRecord(rec)}.\n` +
            'Launching now would put two Genies on one profile, which is what genie#369 is ' +
            'about: the second takes several times longer to open its window and blows the ' +
            'firstWindow budget.\n' +
            'Something did not shut down — look for a spec whose teardown does not close its ' +
            `app, or a leaked Electron process from an earlier run (kill ${rec.pid}, or delete ` +
            `${file} if that pid is long gone).`,
    );
}

/**
 * Wait for one specific pid to leave, for a teardown that wants to PROVE its app
 * is gone rather than assume `close()` meant it.
 */
export async function awaitPidExit(
    pid: number,
    image: string,
    opts: WaitOptions = {},
): Promise<void> {
    const { timeoutMs = 30_000, pollMs = 100 } = opts;

    // The free check settles the overwhelmingly common case on its own: `close()`
    // normally has the process reaped before it even returns, so a teardown that
    // reached for `tasklist` would spend the better part of a second, once per
    // spec, confirming something a syscall already knew.
    if (!pidAlive(pid)) return;
    const rec: InstanceRecord = { pid, image, harness: 'closing', startedAt: Date.now() };
    if (!isRecordedInstanceRunning(rec)) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(pollMs);
        if (!pidAlive(pid)) return;
    }
    // Identity re-checked once before failing, never inside the loop: a pid that
    // died and was reused mid-wait must not fail a teardown that worked.
    if (!isRecordedInstanceRunning(rec)) return;

    throw new Error(
        `genie E2E: Electron pid ${pid} (${image}) was still running ${timeoutMs}ms after ` +
            'close(). Its teardown returned without the process actually exiting — the next ' +
            'launch would overlap it (genie#369).',
    );
}
