import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { claudeOptionsFor, driverEvents } from '../src/main/session-host.js';
import { fakeClaude, type FakeClaude } from './helpers/fake-claude-cli.js';

/**
 * AN OLD CLAUDE CODE SAYS WHAT TO DO (prism-acp 0.30.0, BREAKING). Every Claude agent runs with prism-acp's
 * `permissionPrompts` (genie#1188), and from 0.30.0 that needs Claude Code 2.1.295 or later: the driver reads the
 * version from the `initialize` handshake and ends the session when it is older or missing. Unhandled, the agent went
 * Broken with prism-acp's words — "Claude permission prompts require an initialize version of 2.1.295 or later,
 * consistent with system/init" — and a `Restart` that cannot help. The person must read what to do instead.
 *
 * Driven end to end: Genie's own Claude options (`claudeOptionsFor`) and event wiring (`driverEvents`), prism-acp's REAL
 * ClaudeDriver, and a stand-in CLI that reports the version under test.
 */
const UPDATE = 'Update Claude Code to 2.1.295 or later';

const dirs: string[] = [];
const fakes: FakeClaude[] = [];
afterAll(() => {
    for (const f of fakes) f.cleanup();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function agentOn(version: string) {
    const dir = mkdtempSync(join(tmpdir(), 'genie-old-cli-'));
    dirs.push(dir);
    const cli = fakeClaude({ version });
    fakes.push(cli);
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'moic' });
    const driverFactory: SessionDriverFactory = (options) =>
        new ClaudeDriver({ ...claudeOptionsFor(record, dir, null), binary: process.execPath, binaryArgs: [cli.script] }, driverEvents(options.events));
    const store = openDurableStore(dir);
    const session = new AgentSession({ agentId: record.id, cwd: dir, store, driverFactory, processTree: noProcessTree });
    return { session, store, id: record.id };
}

describe('a Claude Code older than 2.1.295', () => {
    it('ends the agent with what to do: update Claude Code to 2.1.295 or later', async () => {
        const { session, store, id } = agentOn('2.1.200');
        session.start();
        session.prompt('hello');
        await vi.waitFor(() => { expect(session.exit).not.toBeNull(); }, { timeout: 20_000, interval: 50 });
        await session.settled();

        expect(session.turnState).toBe('failed');
        // The row's reason (session-host's probe reads `session.failure`).
        expect(session.failure).toContain(UPDATE);
        // And the chat: the failed run's error notice carries the same words.
        const notices = (await openAgentThread(store, id).messages())
            .map((r) => r.message as { kind: string; level?: string; message?: string })
            .filter((m) => m.kind === 'notice' && m.level === 'error');
        expect(notices.map((n) => n.message).join('\n')).toContain(UPDATE);
    }, 30_000);

    it('CONTROL: Claude Code 2.1.310 (the owner’s) runs the turn — no failure, nothing about updating', async () => {
        const { session } = agentOn('2.1.310');
        session.start();
        session.prompt('hello');
        await vi.waitFor(() => { expect(session.lastTurnEnd).toBe('replied'); }, { timeout: 20_000, interval: 50 });
        expect(session.failure).toBeNull();
        expect(session.turnState).not.toBe('failed');
        await session.stop('SIGTERM', { graceMs: 2_000 });
    }, 30_000);
});
