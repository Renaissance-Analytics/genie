/**
 * THE LIVE CHECK — a real Claude CLI, a real ACP session, a real process scan.
 *
 * This file exists because the build it replaces shipped FOUR releases on a green unit
 * suite, and every one of them was broken the moment a human opened it. A fake driver proves
 * the plumbing and can never prove the protocol; only the real binary can tell you whether
 * `session/update` arrives in the shape the mapper expects.
 *
 * It is deliberately NOT part of `npm test`:
 *  - it needs the provider binary installed and authenticated;
 *  - it spends real subscription tokens, so it asks for the smallest possible turn;
 *  - it is a verification, not a unit test, and a verification that runs 400 times a day
 *    stops being read.
 *
 * Run it with `npm run verify:live` before anything is tagged. What it proves, in order:
 *
 *   1. a session STARTS against the real CLI;
 *   2. a prompt produces a real `agent_message_chunk` — the protocol, not a mock;
 *   3. the provider's own session id is captured, which is what a later resume is keyed on;
 *   4. the thread persists the ledger and SURVIVES being reopened from disk;
 *   5. `stop()` leaves NOTHING behind — asserted by scanning the process table, because the
 *      previous build's stop returned `ok: true` while agents kept running.
 *
 * Exit code 0 means all five held. Anything else prints what failed and why.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { mintAgentId } from '../../src/core/identity.js';
import { openAgentThread, openDurableStore } from '../../src/core/thread-store.js';
import { AgentSession, type SessionDriverFactory } from '../../src/core/session.js';
import type { StreamEvent } from '../../src/core/stream-event.js';

const CLAUDE_BINARY = process.env['GENIE2_CLAUDE_BINARY'] ?? 'claude';

function log(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/**
 * Count live DESCENDANTS of this process.
 *
 * The first version of this matched the temp cwd in each process's command line, and the
 * positive control caught it: the provider is *spawned with* that cwd, it does not carry the
 * path in argv, so the scan found zero both before and after stop. "Nothing survives" passed
 * on no evidence — which is the exact way an absence assertion lies, and the reason 5a
 * exists at all.
 *
 * Walking the process tree from our own pid is both correct and safe on a workstation with
 * other agents running: a descendant of THIS node process can only be something this check
 * started. A bare "is any claude running" count would be meaningless here and destructive
 * anywhere else.
 */
function liveProviderProcesses(_cwd: string): number {
    try {
        if (process.platform === 'win32') {
            const script = [
                '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId;',
                `$queue = @(${process.pid}); $seen = @{};`,
                'while ($queue.Count -gt 0) {',
                '  $pid0 = $queue[0]; $queue = $queue[1..($queue.Count)];',
                '  foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $pid0 }) {',
                '    if (-not $seen.ContainsKey($c.ProcessId)) { $seen[$c.ProcessId] = $true; $queue += $c.ProcessId }',
                '  }',
                '}',
                '$seen.Count',
            ].join(' ');
            const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
                encoding: 'utf8', timeout: 30_000,
            });
            return Number.parseInt(out.trim(), 10) || 0;
        }
        const out = execFileSync('bash', ['-lc', `pgrep -P ${process.pid} | wc -l`], {
            encoding: 'utf8', timeout: 20_000,
        });
        return Number.parseInt(out.trim(), 10) || 0;
    } catch {
        // A scan that cannot run is NOT a pass. NaN so the caller fails loudly rather than
        // reading an error as "nothing is running".
        return Number.NaN;
    }
}

async function main(): Promise<number> {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-live-'));
    const store = openDurableStore(dir);
    const agentId = mintAgentId();
    const events: StreamEvent[] = [];
    let failures = 0;
    const check = (ok: boolean, label: string, detail = ''): void => {
        log(ok, label, detail);
        if (!ok) failures += 1;
    };

    console.log(`\ngenie2 live check — cwd ${dir}\n`);

    // Taken BEFORE anything starts: this process has descendants of its own, and the agent's
    // are only the ones that appear on top of these.
    const baseline = liveProviderProcesses(dir);

    const driverFactory: SessionDriverFactory = (options) =>
        new ClaudeDriver(
            {
                cwd: options.cwd,
                binary: CLAUDE_BINARY,
                // The live check must never be able to edit anything on the owner's machine.
                permissionMode: 'plan',
                ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
            },
            {
                onUpdate: (u) => options.events.onUpdate?.(u as Record<string, unknown>),
                onExit: (code, signal) => options.events.onExit?.(code, signal),
            },
        );

    const session = new AgentSession({
        agentId, cwd: dir, store, driverFactory,
        onEvent: (e) => events.push(e),
    });

    try {
        session.start();
        check(session.running, '1. session starts against the real CLI');

        session.prompt('Reply with exactly the word: ok');

        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !events.some((e) => e.kind === 'message' && e.speaker === 'agent')) {
            await new Promise((r) => setTimeout(r, 500));
        }

        const reply = events.find((e) => e.kind === 'message' && e.speaker === 'agent');
        check(Boolean(reply), '2. a real agent_message_chunk arrived', `${events.length} events seen`);

        check(
            typeof session.cliSessionId === 'string' && session.cliSessionId.length > 0,
            '3. provider session id captured (what a resume is keyed on)',
            String(session.cliSessionId),
        );

        const persistedBefore = await openAgentThread(store, agentId).count();
        // Reopen from disk — the only way to tell persistence from an in-process cache.
        const persistedAfter = await openAgentThread(openDurableStore(dir), agentId).count();
        check(
            persistedBefore > 0 && persistedAfter === persistedBefore,
            '4. ledger persisted and survives reopening from disk',
            `${persistedAfter} rows`,
        );

        const beforeStop = liveProviderProcesses(dir);
        session.stop();
        await new Promise((r) => setTimeout(r, 3_000));
        const afterStop = liveProviderProcesses(dir);
        // Compared against the BASELINE taken before the session started, not against zero.
        // This process already has descendants that have nothing to do with the agent (a tsx
        // wrapper, for one), and demanding zero would fail forever for the wrong reason.
        const leaked = afterStop - baseline;

        // Both halves matter. "0 after" alone passes on a run where the provider never
        // started, which is precisely how an absence assertion lies.
        check(
            beforeStop > baseline,
            '5a. POSITIVE CONTROL: the provider really was running',
            `${beforeStop} mid-run vs ${baseline} at baseline`,
        );
        check(
            !Number.isNaN(afterStop) && leaked <= 0,
            '5b. stop leaves NOTHING behind (process scan vs baseline)',
            Number.isNaN(afterStop)
                ? 'scan failed — treated as a failure'
                : `${afterStop} now, ${baseline} at baseline, ${leaked} leaked`,
        );
    } finally {
        try { session.stop('SIGKILL'); } catch { /* already gone */ }
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(failures === 0 ? '\nLIVE CHECK PASSED\n' : `\nLIVE CHECK FAILED — ${failures} failing\n`);
    return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
    console.error('live check threw:', err);
    process.exit(1);
});
