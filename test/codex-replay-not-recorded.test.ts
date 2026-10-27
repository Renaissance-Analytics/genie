import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { META_REPLAY } from '@particle-academy/prism-acp';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';

/**
 * A REPLAYED UPDATE IS KNOWN BY ITS MARK, NOT BY WHEN IT ARRIVES (prism-acp 0.31.0). Genie keeps its own history, so a
 * provider replaying a resumed thread (prism-acp's CodexDriver before `replayHistory: false`) must not write it again.
 * Until 0.31.0 the replay carried no mark, so Genie dropped what arrived BEFORE `ready` on a resumed Codex session
 * (2026-10-23; genie#1249). That window was a guess, and wrong both ways: a live notification arriving mid-replay is not
 * history (prism-acp does not mark it) and was dropped; a replayed update after `ready` would have been recorded.
 * prism-acp now marks every replayed update `_meta["particle.academy/replay"] = true` (META_REPLAY). That mark, and
 * only that mark, keeps an update out of the ledger.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const replay = { _meta: { [META_REPLAY]: true } };

function open(opts: { resume: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-replay-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => { markReady = r; });
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, ready, get running() { return true; }, get cliSessionId() { return null; } } as never;
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree,
        ...(opts.resume ? { resumeSessionId: 'thread-01a16563' } : {}),
    });
    session.start();
    const say = (text: string, extra: Record<string, unknown> = {}) => events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...extra });
    const rows = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; text?: string; speaker?: string });
    };
    return { session, say, markReady, rows, end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}

const messages = async (s: ReturnType<typeof open>) => (await s.rows()).filter((r) => r.kind === 'message').map((r) => `${r.speaker}:${r.text}`);

describe('a resumed session: the replay mark decides, not the clock', () => {
    it('drops a replayed message that arrives before ready', async () => {
        const s = open({ resume: true });
        s.say('I read the project overview earlier.', replay);
        s.markReady();
        await Promise.resolve();
        expect(await messages(s)).toEqual([]);
    });

    it('drops a replayed message that arrives AFTER ready too', async () => {
        const s = open({ resume: true });
        s.markReady();
        await new Promise((r) => setTimeout(r, 0));
        s.say('An earlier reply, replayed late.', replay);
        s.end();
        expect(await messages(s)).toEqual([]);
    });

    it('records a LIVE message that arrives before ready (prism-acp does not mark a live notification mid-replay)', async () => {
        const s = open({ resume: true });
        s.say('Live, while the history was still loading.');
        s.markReady();
        s.end();
        expect(await messages(s)).toEqual(['agent:Live, while the history was still loading.']);
    });

    it('records what the agent says after ready, as ever (control)', async () => {
        const s = open({ resume: true });
        s.say('replayed', replay);
        s.markReady();
        await new Promise((r) => setTimeout(r, 0));
        s.session.prompt('carry on', 'you');
        s.say('Carrying on now.');
        s.end();
        expect(await messages(s)).toEqual(['you:carry on', 'agent:Carrying on now.']);
    });
});

describe('sessions that do not replay are unchanged (controls)', () => {
    it('a FRESH session records a message before ready', async () => {
        const s = open({ resume: false });
        s.say('A fresh thread speaks.');
        s.end();
        expect((await s.rows()).filter((r) => r.kind === 'message').map((r) => r.text)).toEqual(['A fresh thread speaks.']);
    });
});
