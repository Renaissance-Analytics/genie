/**
 * DOES AN EXITED PTY GIVE ITS RESOURCES BACK? — the measurement whose ABSENCE is genie#805.
 *
 * 2026-10-06: the pty-host (fancy-term-host 0.5.0 on node-pty 1.1.0) held 88 GB of commit,
 * 79k handles and 7.2k threads for ~41 live terminals, after 7,158 spawns and 7,116 exits —
 * ~12 MB, ~1 thread and ~11 handles retained per EXITED pty. The log had the spawn and exit
 * counts the whole time; nothing compared threads against live terminals, so it accumulated
 * for four days in plain sight. genie2 runs its terminals in the app's main process, so the
 * same leak would eat the application the user is looking at.
 *
 * **Runs in the test VM only** — `npm run verify:leak` via `scripts/vm-run.sh`.
 *
 * What it measures: this process's threads, open handles/fds and resident memory, before and
 * after N open→exit cycles with ZERO terminals live at the end, through the real engine. The
 * assertion is on growth PER EXITED PTY, and the thresholds are set from the incident's
 * numbers (which this check must go RED against) with headroom for a tidy engine:
 *
 *   threads   ≤ 0.1 / exited pty   (incident: ~1.0)
 *   handles   ≤ 1.0 / exited pty   (incident: ~11)
 *   memory    ≤ 0.5 MB / exited pty (incident: ~12 MB)
 *
 * Positive control: the same gauges are read with N terminals LIVE mid-run and must show the
 * growth — a gauge that reads the same with 40 live ptys as with 0 is not measuring anything.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { TerminalHost } from '../../src/main/terminal-host.js';

const CYCLES = Number(process.env.LEAK_CYCLES ?? 120);
const LIVE_BATCH = Number(process.env.LEAK_LIVE ?? 20);

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

interface Gauges { threads: number; handles: number; rssMb: number }

/** This process's own gauges, from the OS — never from Node's idea of itself. */
function gauges(): Gauges {
    if (process.platform === 'win32') {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            `$p = Get-Process -Id ${process.pid}; "$($p.Threads.Count) $($p.HandleCount) $([math]::Round($p.WorkingSet64 / 1MB, 1))"`,
        ], { encoding: 'utf8', timeout: 20_000 }).trim().split(/\s+/);
        return { threads: Number(out[0]), handles: Number(out[1]), rssMb: Number(out[2]) };
    }
    const status = readFileSync('/proc/self/status', 'utf8');
    const num = (key: string) => Number((status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? NaN);
    return { threads: num('Threads'), handles: readdirSync('/proc/self/fd').length, rssMb: Math.round(num('VmRSS') / 1024 * 10) / 10 };
}
const fmt = (g: Gauges) => `threads ${g.threads}, handles ${g.handles}, rss ${g.rssMb} MB`;

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
    const userData = mkdtempSync(join(tmpdir(), 'genie2-leak-'));
    console.log(`\ngenie2 live TERMINAL LEAK check — ${CYCLES} open→exit cycles, ${LIVE_BATCH} live for the control\n`);
    const MARK = Buffer.from('GT1');
    const encryptor = {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([MARK, Buffer.from(b.map((x) => x ^ 0x5a))]),
        decrypt: (b: Buffer) => {
            if (!b.subarray(0, MARK.length).equals(MARK)) throw new Error('decrypt on foreign bytes');
            return Buffer.from(b.subarray(MARK.length).map((x) => x ^ 0x5a));
        },
    };
    const host = new TerminalHost(realFancyTermPort(userData, encryptor));
    const exits = new Set<string>();
    host.onExit((id) => { exits.add(id); });
    const shortCommand = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';
    const longCommand = process.platform === 'win32' ? 'cmd /c ping -n 60 127.0.0.1 >nul' : 'sleep 60';

    try {
        // Warm-up: the first pty pays one-time costs (engine init, conpty load). Not counted.
        const warm = host.open({ workspaceId: 'leak', cwd: userData, command: shortCommand });
        await until(() => exits.has(warm.id), 10_000);
        await new Promise((r) => setTimeout(r, 500));
        const before = gauges();
        console.log(`  baseline (after warm-up, 0 live):   ${fmt(before)}`);

        // POSITIVE CONTROL: with LIVE_BATCH terminals open the gauges MUST move.
        const live = Array.from({ length: LIVE_BATCH }, () => host.open({ workspaceId: 'leak', cwd: userData, command: longCommand }));
        await new Promise((r) => setTimeout(r, 1000));
        const withLive = gauges();
        console.log(`  with ${LIVE_BATCH} live:                     ${fmt(withLive)}`);
        check(withLive.handles > before.handles || withLive.threads > before.threads,
            `CONTROL: ${LIVE_BATCH} live terminals are visible in the gauges`,
            `+${withLive.handles - before.handles} handles, +${withLive.threads - before.threads} threads`);
        for (const t of live) host.close(t.id);
        const liveGone = await until(() => live.every((t) => exits.has(t.id)), 20_000);
        check(liveGone, 'CONTROL: all live terminals reported their exit', `${live.filter((t) => exits.has(t.id)).length}/${LIVE_BATCH}`);
        check(live.every((t) => !pidAlive(t.pid)), 'CONTROL: and their pids are gone');

        // THE MEASUREMENT: N cycles, each a pty that runs to its own exit.
        let exited = 0;
        const t0 = Date.now();
        for (let i = 0; i < CYCLES; i += 1) {
            const t = host.open({ workspaceId: 'leak', cwd: userData, command: shortCommand });
            const ok = await until(() => exits.has(t.id), 10_000);
            if (!ok) { check(false, `cycle ${i}: the pty never reported its exit`); break; }
            exited += 1;
        }
        check(exited === CYCLES, `${CYCLES} ptys opened and ran to exit`, `${exited} in ${Date.now() - t0} ms`);
        check(host.count === 0, 'the host counts ZERO live terminals afterwards', `count=${host.count}`);
        await new Promise((r) => setTimeout(r, 1500));
        const after = gauges();
        console.log(`  after ${exited} exits (0 live):          ${fmt(after)}`);

        const perThreads = (after.threads - before.threads) / exited;
        const perHandles = (after.handles - before.handles) / exited;
        const perMb = (after.rssMb - before.rssMb) / exited;
        console.log(`  retained per exited pty: ${perThreads.toFixed(3)} threads, ${perHandles.toFixed(2)} handles, ${perMb.toFixed(3)} MB`);
        check(perThreads <= 0.1, 'threads retained per exited pty ≤ 0.1  (genie#805: ~1.0)', perThreads.toFixed(3));
        check(perHandles <= 1.0, 'handles retained per exited pty ≤ 1.0  (genie#805: ~11)', perHandles.toFixed(2));
        check(perMb <= 0.5, 'memory retained per exited pty ≤ 0.5 MB  (genie#805: ~12 MB)', `${perMb.toFixed(3)} MB`);
    } finally {
        host.closeAll();
        rmSync(userData, { recursive: true, force: true, maxRetries: 10 });
    }

    console.log('');
    if (failures.length > 0) {
        console.error(`TERMINAL LEAK CHECK FAILED — ${failures.length}:`);
        for (const f of failures) console.error(`  ${f}`);
        process.exit(1);
    }
    console.log('TERMINAL LEAK CHECK PASSED');
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(`TERMINAL LEAK CHECK CRASHED: ${String(error)}`);
    process.exit(2);
});
