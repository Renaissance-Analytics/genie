import { CodexDriver, META_REPLAY, META_REPLAY_SUMMARY } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { REPLAY_META, REPLAY_SUMMARY_META } from '../src/core/stream-event.js';
import { codexOptionsFor } from '../src/main/session-host.js';

/**
 * A RESUMED CODEX AGENT DOES NOT FETCH ITS HISTORY (prism-acp 0.31.0 `replayHistory: false`). Genie keeps its own ledger,
 * so the replay was only ever dropped again (genie#1249/#1251) — and the agent's first turn waited for it: prism-acp paged
 * the whole thread (`thread/turns/list`, then `thread/items/list` per turn) before `ready`, up to five minutes for a long
 * thread. Codex keeps the conversation itself: measured by prism on codex 0.163.0, the saved thread is still in the next
 * model request (and again in test/live/codex-resume-ttft.live.ts).
 *
 * Genie 1 never fetched history on a Codex resume either: v0.7.0-beta.342 main/agentinbox/codex-app-server.ts:77-93 sends
 * `initialize`, then `thread/resume { threadId, cwd }`, and is ready.
 *
 * Measured against the real CodexDriver with a fake App Server that holds one saved turn: what Codex is asked for.
 */
const record = { id: 'ag_1', name: 'kai', provider: 'codex', workspaceId: 'w', permissions: 'all', model: null } as unknown as AgentRecord;

async function resume(options: ConstructorParameters<typeof CodexDriver>[0]): Promise<{ methods: string[]; updates: Record<string, unknown>[] }> {
    const methods: string[] = [];
    const updates: Record<string, unknown>[] = [];
    const driver = new CodexDriver(options, { onUpdate: (u: unknown) => { updates.push(u as Record<string, unknown>); } } as never, (_o, h) => ({
        start: async () => {},
        send: (frame) => {
            const f = frame as { id?: number; method?: string; params?: Record<string, unknown> };
            if (f.method === undefined || f.id === undefined) return;
            methods.push(f.method);
            const answer = (result: unknown) => queueMicrotask(() => h.onFrame({ jsonrpc: '2.0', id: f.id, result }));
            if (f.method === 'initialize') answer({});
            else if (f.method === 'config/read') answer({ config: { mcp_servers: {}, shell_environment_policy: {} } });
            else if (f.method === 'thread/resume') answer({ thread: { id: f.params?.['threadId'] }, model: 'gpt-5' });
            else if (f.method === 'account/rateLimits/read') answer({});
            else if (f.method === 'thread/turns/list') answer({ data: [{ id: 'turn_1' }], nextCursor: null });
            else if (f.method === 'thread/items/list') answer({ data: [{ type: 'agentMessage', id: 'msg_1', text: 'an earlier reply' }], nextCursor: null });
            else queueMicrotask(() => h.onFrame({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: 'not in this fake' } }));
        },
        close: () => {},
    }));
    void Promise.resolve(driver.start()).catch(() => {});
    try {
        await driver.ready;
        return { methods, updates };
    } finally { driver.kill(); }
}

const replayed = (updates: readonly Record<string, unknown>[]) =>
    updates.filter((u) => typeof u['_meta'] === 'object' && u['_meta'] !== null && (u['_meta'] as Record<string, unknown>)[META_REPLAY] === true);

describe('a Codex agent resumed by Genie does not fetch its history', () => {
    it('Genie asks for no replay on a resume: replayHistory false', () => {
        expect(codexOptionsFor(record, '/w', 'thr_1', [])).toMatchObject({ resumeSessionId: 'thr_1', replayHistory: false });
    });

    it('a fresh thread has nothing to replay, and says nothing about it', () => {
        expect(codexOptionsFor(record, '/w', null, [])).not.toHaveProperty('replayHistory');
    });

    it('is ready after thread/resume: no thread/turns/list, no thread/items/list, no replayed update', async () => {
        const { methods, updates } = await resume(codexOptionsFor(record, '/w', 'thr_1', []));
        expect(methods).toContain('thread/resume');
        expect(methods).not.toContain('thread/turns/list');
        expect(methods).not.toContain('thread/items/list');
        expect(replayed(updates)).toEqual([]);
    });

    it('Genie reads the replay mark under prism-acp’s own keys (core keeps them as strings: no runtime prism import)', () => {
        expect(REPLAY_META).toBe(META_REPLAY);
        expect(REPLAY_SUMMARY_META).toBe(META_REPLAY_SUMMARY);
    });

    it('CONTROL: the same fake, with replay left on, IS paged and replayed (the fake can show what the test says is absent)', async () => {
        const { methods, updates } = await resume({ cwd: '/w', resumeSessionId: 'thr_1' });
        expect(methods).toContain('thread/turns/list');
        expect(methods).toContain('thread/items/list');
        expect(replayed(updates).length).toBeGreaterThan(0);
    });
});
