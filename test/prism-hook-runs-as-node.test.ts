import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type PermissionRequestLike, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { claudeOptionsFor, driverEvents } from '../src/main/session-host.js';
import { asElectron, fakeClaude, type FakeClaude } from './helpers/fake-claude-cli.js';

/**
 * THE APPROVAL HOOK NEVER LAUNCHES A SECOND GENIE (genie#1235, prism-acp 0.30.0).
 *
 * prism-acp writes Claude's PreToolUse hook as Genie's own runtime (`process.execPath` — Genie.exe inside Genie) on its
 * approve.cjs. Before 0.30.0 that launch carried no ELECTRON_RUN_AS_NODE: Genie.exe started as Genie, asked the
 * single-instance lock, and the running Genie raised its window on every shell call (genie#1237 worked around it in
 * main.ts). From 0.30.0, under Electron, prism-acp's hook sets ELECTRON_RUN_AS_NODE=1 for the hook process alone (the
 * POSIX `/bin/sh` wrapper, and on Windows its hash-verified native adapter), so Electron runs approve.cjs as Node and
 * Genie's main — the lock, `second-instance` — never runs at all.
 *
 * MEASURED, not read from the settings string: a stand-in Claude runs the hook exactly as Claude does (exec form), with
 * the hook script swapped for a probe that records the ELECTRON_RUN_AS_NODE its runtime was started with. Then the hook
 * is run as written, and its answer must be Genie's own per-call decision — allow runs (exit 0), deny blocks (exit 2).
 */
const dirs: string[] = [];
const fakes: FakeClaude[] = [];
afterAll(() => {
    for (const f of fakes) f.cleanup();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

/** One Claude agent, as Genie starts it, inside a process that looks like Electron's main; runs one turn. */
async function oneTurn(hook: 'run' | 'probe', decision: 'allow' | 'deny' = 'allow') {
    const dir = mkdtempSync(join(tmpdir(), 'genie-hook-'));
    dirs.push(dir);
    const cli = fakeClaude({ version: '2.1.310', hook });
    fakes.push(cli);
    const asked: PermissionRequestLike[] = [];
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'moic' });
    const driverFactory: SessionDriverFactory = (options) =>
        new ClaudeDriver({ ...claudeOptionsFor(record, dir, null), binary: process.execPath, binaryArgs: [cli.script] }, driverEvents(options.events));
    const session = new AgentSession({
        agentId: record.id, cwd: dir, store: openDurableStore(dir), driverFactory, processTree: noProcessTree,
        permissionDecision: (request) => { asked.push(request); return decision; },
    });
    await asElectron(async () => {
        session.start();
        session.prompt('run echo hi');
        await vi.waitFor(() => { expect(session.lastTurnEnd).not.toBeNull(); }, { timeout: 25_000, interval: 50 });
    });
    await session.stop('SIGTERM', { graceMs: 2_000 });
    return { cli, asked, session };
}

describe('prism-acp runs the approval hook as Node under Electron', () => {
    it('Genie leaves prism-acp to pick the hook runtime (no nodePath), so the Electron default applies', () => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'moic' });
        expect(claudeOptionsFor(record, '/w', null).permissionPrompts).toEqual({ tools: ['Bash', 'PowerShell'] });
    });

    it('the hook process is started with ELECTRON_RUN_AS_NODE=1 on Genie’s own runtime — never a second Genie', async () => {
        const { cli } = await oneTurn('probe');
        const settings = cli.settings();
        const entry = settings?.hooks?.PreToolUse?.[0]?.hooks[0];
        // The runtime the hook starts is this process's own executable (Genie.exe inside Genie).
        expect(entry?.args ?? []).toContain(process.execPath);
        const run = cli.hookRun();
        expect(run?.electronRunAsNode).toBe('1');
        // The probe answered prism-acp's explicit allow, and the guard turned it into Claude's "go ahead".
        expect(run?.status).toBe(0);
    }, 40_000);

    it('the real hook asks Genie’s running session, and Genie’s ALLOW lets the call run (exit 0)', async () => {
        const { cli, asked } = await oneTurn('run', 'allow');
        expect(asked).toHaveLength(1);
        expect(JSON.stringify(asked[0])).toContain('echo hi');
        expect(cli.hookRun()?.status).toBe(0);
    }, 40_000);

    it('CONTROL: Genie’s DENY blocks the call (exit 2) — the answer is Genie’s, not a default', async () => {
        const { cli, asked } = await oneTurn('run', 'deny');
        expect(asked).toHaveLength(1);
        expect(cli.hookRun()?.status).toBe(2);
    }, 40_000);
});

describe('Electron honours ELECTRON_RUN_AS_NODE in Genie’s build', () => {
    it('the RunAsNode fuse is not turned off (that would make Genie.exe ignore it and start Genie again)', () => {
        const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
        const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
        // POSITIVE CONTROL for the read: the files are the real ones.
        expect(builder).toMatch(/appId:/);
        expect(pkg).toMatch(/"name": "genie"/);
        expect(builder).not.toMatch(/runAsNode\s*:\s*false/i);
        expect(pkg).not.toMatch(/runAsNode"?\s*:\s*false/i);
        expect(builder).not.toMatch(/RunAsNode\]?\s*:\s*false/);
    });
});
