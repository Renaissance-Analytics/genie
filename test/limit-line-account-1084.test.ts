import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { SOURCE_NOTICE_NOW, sourceRateLimitNotice } from './fixtures/rate-limit-source.js';

/**
 * THE STREAM'S LIMIT LINE NAMES WHOSE LIMIT IT IS (Tynn #1084). The owner's coordinator showed "67% of 7d window left" from
 * the account it was still on, while the panel said the active (other) account was unread; nothing said which account the
 * line was. The row keeps the account the run was on when the reading came, so a later switch does not re-label it.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open(label: (() => string | null) | undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'genie-1084-line-')); dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree, turnsBefore: 0, ...(label ? { readingAccountLabel: label } : {}) });
    session.start();
    const limitRows = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; headroom?: unknown; account?: string }).filter((m) => m.kind === 'notice' && m.headroom);
    };
    return { send: (u: Record<string, unknown>) => events.onUpdate?.(u as never), limitRows };
}

describe('a rate-limit row keeps the account its reading came from', () => {
    it('the row names the account the run was on then, and keeps it after a switch', async () => {
        let on = 'wish+ai@';
        const s = open(() => on);
        s.send(sourceRateLimitNotice('claude', 67, SOURCE_NOTICE_NOW + 3_600_000));
        await vi.waitFor(async () => expect(await s.limitRows()).toHaveLength(1));
        on = 'wish@';
        const rows = await s.limitRows();
        expect(rows[0]!.account).toBe('wish+ai@');
    });

    it('CONTROL: with no account known the row carries none', async () => {
        const s = open(undefined);
        s.send(sourceRateLimitNotice('claude', 67, SOURCE_NOTICE_NOW + 3_600_000));
        await vi.waitFor(async () => expect(await s.limitRows()).toHaveLength(1));
        expect((await s.limitRows())[0]!.account).toBeUndefined();
    });
});
