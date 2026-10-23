import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';

/**
 * A RESUMED CODEX AGENT DOES NOT WRITE ITS PAST INTO GENIE'S HISTORY AGAIN (2026-10-23). Since prism-acp 0.23.1 a
 * graceful restart of a Codex agent works — and on every resume prism-acp's CodexDriver REPLAYS the thread's history
 * (`transcriptReplay: true`; Claude's driver does not) before its `ready` resolves. Genie keeps its own history, so it
 * recorded every replayed message as a new row: as `peer` rows under prism-acp 0.24.0 (the empty peer rows tynn-slave
 * reported) and as agent messages under 0.24.1. A resumed session whose driver replays its transcript now drops the
 * replayed message / thought / tool / plan rows that arrive before `ready`; live rows after `ready` are recorded as ever,
 * and a session that does not replay (Claude, or a fresh start) is unchanged.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open(opts: { resume: boolean; replays: boolean }) {
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
        replaysTranscript: opts.replays,
    });
    session.start();
    const say = (text: string) => events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const peer = (text: string) => events.onUpdate?.({ sessionUpdate: 'session_message', from: 'codex', content: [{ type: 'text', text }] });
    const rows = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; text?: string; speaker?: string });
    };
    return { session, say, peer, markReady, rows, end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}

describe('a resumed Codex session (its driver replays the transcript)', () => {
    it('drops the replayed rows that arrive before ready, in either shape prism-acp has sent them', async () => {
        const s = open({ resume: true, replays: true });
        s.say('I read the project overview earlier.');   // 0.24.1's shape
        s.peer('An earlier reply, replayed.');            // 0.24.0's shape
        s.markReady();
        await Promise.resolve();
        const messages = (await s.rows()).filter((r) => r.kind === 'message');
        expect(messages).toEqual([]);
    });

    it('records what the agent says AFTER ready, as ever (control)', async () => {
        const s = open({ resume: true, replays: true });
        s.say('replayed');
        s.markReady();
        await new Promise((r) => setTimeout(r, 0));
        s.session.prompt('carry on', 'you');
        s.say('Carrying on now.');
        s.end();
        const messages = (await s.rows()).filter((r) => r.kind === 'message').map((r) => `${r.speaker}:${r.text}`);
        expect(messages).toEqual(['you:carry on', 'agent:Carrying on now.']);
    });
});

describe('sessions that do not replay are unchanged (controls)', () => {
    it('a resumed Claude session (no transcript replay) records a message before ready', async () => {
        const s = open({ resume: true, replays: false });
        s.say('Claude says this early.');
        s.end();
        expect((await s.rows()).filter((r) => r.kind === 'message').map((r) => r.text)).toEqual(['Claude says this early.']);
    });

    it('a FRESH Codex session (nothing to replay) records a message before ready', async () => {
        const s = open({ resume: false, replays: true });
        s.say('A fresh thread speaks.');
        s.end();
        expect((await s.rows()).filter((r) => r.kind === 'message').map((r) => r.text)).toEqual(['A fresh thread speaks.']);
    });
});
