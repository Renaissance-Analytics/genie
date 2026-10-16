/**
 * DOES A REAL TERMINAL ACTUALLY RUN A COMMAND? — `fancy-term-host` + node-pty, for real.
 *
 * The unit tests prove the mapping with a fake backend. They cannot prove that node-pty loads
 * in this runtime, that a shell spawns, that output comes back, or that a kill actually ends
 * the process. Only a real pty can, and this is that check.
 *
 * **Runs in the test VM only** — `scripts/vm-run.sh genie-test-ubuntu repos/genie2 'npm run
 * verify:terminal'`. It spawns a shell and kills it. Nothing here is unsafe in itself; the rule
 * is that nothing like it runs on the owner's desktop, and a check that reaps processes is
 * exactly the class that killed Genie's host service on 2026-10-10.
 *
 * What it proves, in order:
 *   1. the engine opens a pty for a plain shell, with a real pid;
 *   2. a command written to it produces output that comes back through `onData` — with a
 *      random token, so a stale buffer or a prompt echo cannot pass as the command's output;
 *   3. a second terminal is a second pid — the engine did not hand back the first one;
 *   4. `close` reports the exit and the pid is gone from the process table afterwards — the
 *      promise the previous build broke for agents, asserted here for terminals.
 *
 * Positive control for (4): the pid was alive BEFORE the close, measured the same way.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { TerminalHost } from '../../src/main/terminal-host.js';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

/**
 * Is this pid in the process table? Linux: /proc. Windows: tasklist, filtered to the pid.
 *
 * The Windows branch used to return `true` unconditionally ("not asserted on Windows yet"),
 * which made 4c and 5 unpassable there rather than vacuous — the first Windows run of this
 * check (2026-10-10) could not have reached them anyway: step 3 asked for `sleep 30`, which
 * Windows does not have, and the cleanup's EBUSY buried that error. All three fixed together.
 */
function pidAlive(pid: number): boolean {
    if (process.platform === 'win32') {
        try {
            const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 10_000 });
            return out.includes(String(pid));
        } catch {
            return false;
        }
    }
    return existsSync(`/proc/${pid}`);
}

async function main(): Promise<void> {
    const userData = mkdtempSync(join(tmpdir(), 'genie2-term-'));
    const token = `genie-${randomUUID().slice(0, 8)}`;
    console.log(`\ngenie2 live TERMINAL check — userData ${userData}\n  the token is ${token}\n`);

    /*
     * An encryptor that REALLY transforms bytes, and DIRECTIONALLY, so the snapshot path under
     * test is the one production takes (`0x01`, encrypted) and a wrong-direction call cannot
     * pass. The first version reversed the bytes — a transform, but an involution:
     * `encrypt(encrypt(x)) === x`, so a read path that called `encrypt` would still round-trip
     * and the check would not see it. Fancy measured that on their own double and found the
     * same thing. So: XOR plus a marker, and `decrypt` THROWS without the marker. Not a cipher
     * and not pretending to be; the property this check needs is that direction is observable.
     * Electron passes `safeStorage`.
     */
    const MARK = Buffer.from('GT1');
    const encryptor = {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([MARK, Buffer.from(b.map((x) => x ^ 0x5a))]),
        decrypt: (b: Buffer) => {
            if (!b.subarray(0, MARK.length).equals(MARK)) throw new Error('decrypt called on bytes this encryptor did not write');
            return Buffer.from(b.subarray(MARK.length).map((x) => x ^ 0x5a));
        },
    };
    const host = new TerminalHost(realFancyTermPort(userData, encryptor));
    let output = '';
    const exits: Array<{ id: string; code: number }> = [];
    const pids: number[] = [];
    host.onData((_id, data) => { output += data; });
    host.onExit((id, code) => exits.push({ id, code }));

    try {
        const first = host.open({ workspaceId: 'live', cwd: userData, cols: 100, rows: 30 });
        pids.push(first.pid);
        check(first.pid > 0, '1. a real pty opened for the default shell', `pid ${first.pid}, shell ${first.shell}`);
        check(host.count === 1, '1b. and the host counts it', `count=${host.count}`);

        // Let the shell come up before typing at it. A command written before the prompt is
        // usually still read, but asserting on that is asserting on a race.
        await new Promise((r) => setTimeout(r, 800));
        host.write(first.id, `echo ${token}\n`);

        const echoed = await until(() => output.includes(token), 10_000);
        check(echoed, '2. a command written to it came back through onData', echoed ? 'token seen' : output.slice(-120));

        // A long-lived child that is NOT a shell, so its exit is the close and nothing else.
        const longCommand = process.platform === 'win32' ? 'cmd.exe /c ping -n 30 127.0.0.1 >nul' : 'sleep 30';
        const second = host.open({ workspaceId: 'live', cwd: userData, command: longCommand });
        pids.push(second.pid);
        check(second.pid !== first.pid && second.pid > 0, '3. a second terminal is a second process', `pids ${first.pid} / ${second.pid}`);

        // POSITIVE CONTROL for the kill: alive before, measured the way "gone" will be measured.
        const aliveBefore = pidAlive(second.pid);
        check(aliveBefore, '4a. CONTROL: the second pid is alive before close', String(second.pid));

        host.close(second.id);
        const exited = await until(() => exits.some((e) => e.id === second.id), 10_000);
        check(exited, '4b. close reports the exit through onExit', JSON.stringify(exits.find((e) => e.id === second.id) ?? null));

        const gone = await until(() => !pidAlive(second.pid), 5_000);
        check(gone, '4c. and the pid is GONE from the process table', String(second.pid));

        host.closeAll();
        const allGone = await until(() => !pidAlive(first.pid), 5_000);
        check(allGone && host.count === 0, '5. closeAll leaves nothing behind', `count=${host.count}`);
    } finally {
        host.closeAll();
        // The ptys' cwd IS userData; on Windows a directory with a live cwd in it is EBUSY. Wait
        // for the kills to land, and never let the cleanup's own failure replace the check's —
        // that is exactly how the first Windows run reported "EBUSY" instead of "no sleep".
        await until(() => pids.every((p) => !pidAlive(p)), 5_000);
        try {
            rmSync(userData, { recursive: true, force: true, maxRetries: 10 });
        } catch (error: unknown) {
            console.error(`  (cleanup could not remove ${userData}: ${String(error)})`);
        }
    }

    console.log('');
    if (failures.length > 0) {
        console.error(`TERMINAL CHECK FAILED — ${failures.length}:`);
        for (const f of failures) console.error(`  ${f}`);
        process.exit(1);
    }
    console.log('TERMINAL CHECK PASSED — a real shell ran a real command, and closing it left nothing behind.\n');
    process.exit(0);
}

await main();
