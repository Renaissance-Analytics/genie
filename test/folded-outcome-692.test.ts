import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { deferredDriverFactory } from '../src/main/deferred-driver.js';

// The published 0.42.0 additions, structurally declared so RED compiles on the old consumer seam.
type Outcome = TurnOutcomeLike & { readonly turnId?: string; readonly foldedInto?: string };
const END: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: 'end_turn' };
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
    for (const session of sessions.splice(0)) { await session.stop('SIGTERM'); await session.settled(); }
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function open(reenter = false) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-folded-outcome-692-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: string[] = [];
    const rows: StreamEvent[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, kill: () => {}, running: true, cliSessionId: null,
            prompt: (text) => { prompts.push(String(text)); return `turn-${prompts.length}`; } };
    };
    let reentered = false;
    const session = new AgentSession({ processTree: tree, agentId: mintAgentId(), cwd: dir,
        store: openDurableStore(dir), driverFactory: factory, turnsBefore: 0,
        onEvent: (event) => { rows.push(event); },
        onStateChange: () => {
            if (reenter && !reentered && session.lastTurnEnd === 'replied') {
                reentered = true;
                session.deliver('new work from the listener', 'you');
            }
        } });
    sessions.push(session);
    session.start();
    const end = (outcome: Outcome) => events.onTurnEnd?.(outcome);
    const counts = () => rows.flatMap((r) => r.kind === 'turn' || r.kind === 'finished' || r.kind === 'stopped' ? [`${r.kind}:${r.n}`] : []);
    return { session, prompts, end, counts, rows,
        say: () => events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a reply' } }),
        usage: () => events.onUpdate?.({ sessionUpdate: 'usage_update', used: 100, size: 200000,
            _meta: { 'particle.academy/usage': { scope: 'turn', inputTokens: 10, outputTokens: 20 } } }) };
}

describe('the published folded outcome settles its joined turn only (Tynn #692)', () => {
    it('pins exactly 0.47.0 and its registry integrity in both manifests', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
        expect(pkg.dependencies['@particle-academy/prism-acp']).toBe('0.47.0');
        expect(lock.packages[''].dependencies['@particle-academy/prism-acp']).toBe('0.47.0');
        // 0.44.0 (Tynn #926): G-313's unsolicited turn end and G-314's ping / lastFrameAt / Codex running; kept through 0.47.0
        // (Tynn #1011: claudeAccounts, prepare's shared session store, Remote Control forced off, and 0.47.0's browser
        // login()/logout()). The integrity is npm's own for the 0.47.0 tarball (npm view @particle-academy/prism-acp@0.47.0 dist.integrity).
        expect(lock.packages['node_modules/@particle-academy/prism-acp']).toMatchObject({ version: '0.47.0',
            integrity: 'sha512-LPmj5xQQ8tWM+uzostD0IV397H3rYso0h0OT75Z35NL5Db2/b7tbMACU7OvkyzIVX58LA4ncJVsoaUxrV5E1cg==' });
    });
    it('has no usage-result fallback or owed-end counting after adopting typed outcomes', () => {
        const source = readFileSync('src/core/session.ts', 'utf8');
        for (const name of ['#sawTurnResult', '#endHeldTurn', '#endsOwed', '#endsOut', '#resultAwaitingEnd', 'function isTurnResult(']) {
            expect(source, name).not.toContain(name);
        }
    });
    it('a folded success creates no phantom turn, finish or second end', async () => {
        const s = await open();
        s.session.deliver('first', 'you'); s.session.deliver('folded', 'peer');
        s.end({ ...END, turnId: 'turn-1' });
        s.end({ ...END, turnId: 'turn-2', foldedInto: 'turn-1' });
        expect(s.counts()).toEqual(['turn:1', 'finished:1']);
        expect(s.session.turns).toBe(1);
        expect(s.session.turnState).toBe('idle');
        expect(s.session.cooling).toBe(true);
    });
    it('a folded cancellation stays joined and never resends consumed input', async () => {
        const s = await open();
        s.session.deliver('first', 'you'); s.session.deliver('folded', 'you');
        const cancelled: Outcome = { stopReason: 'cancelled', isError: false, raw: 'cancelled', turnId: 'turn-1' };
        s.end(cancelled); s.end({ ...cancelled, turnId: 'turn-2', foldedInto: 'turn-1' });
        await Promise.resolve();
        expect(s.prompts).toEqual(['first', 'folded']);
        expect(s.counts()).toEqual(['turn:1', 'stopped:1']);
        expect(s.session.turns).toBe(1);
        expect(s.session.cooling).toBe(false);
    });
    it('a folded failure preserves the actual parent failure and counts it once', async () => {
        const s = await open();
        s.session.deliver('first', 'you'); s.session.deliver('folded', 'peer');
        const failed: Outcome = { turnId: 'turn-1', stopReason: null, isError: true, raw: 'provider failure',
            failure: { kind: 'other', reason: 'fixture provider failure' } };
        s.end(failed); s.end({ ...failed, turnId: 'turn-2', foldedInto: 'turn-1' });
        expect(s.session.turns).toBe(1);
        expect(s.session.turnState).toBe('failed');
        expect(s.session.failure).toBe('fixture provider failure');
        expect(s.counts()).toEqual(['turn:1']);
    });
    it('the old folded callback cannot end a new turn started by the parent end listener', async () => {
        const s = await open(true);
        s.session.deliver('first', 'you'); s.session.deliver('folded', 'peer');
        s.end({ ...END, turnId: 'turn-1' });
        expect(s.prompts).toHaveLength(3);
        s.end({ ...END, turnId: 'turn-2', foldedInto: 'turn-1' });
        expect(s.session.turnState).toBe('working');
        expect(s.counts()).toEqual(['turn:1', 'finished:1', 'turn:2']);
        s.end({ ...END, turnId: 'turn-3' });
        expect(s.counts()).toEqual(['turn:1', 'finished:1', 'turn:2', 'finished:2']);
    });
    it('removes the folded prompt by id and preserves an unrelated prompt that runs as its own silent turn', async () => {
        const s = await open();
        s.session.deliver('first', 'you'); s.session.deliver('folded', 'peer'); s.session.deliver('own turn', 'other');
        s.end({ ...END, turnId: 'turn-1' });
        s.end({ ...END, turnId: 'turn-2', foldedInto: 'turn-1' });
        s.end({ ...END, turnId: 'turn-3' });
        expect(s.rows.filter((r) => r.kind === 'turn').map((r) => r.by)).toEqual(['you', 'other']);
        expect(s.counts()).toEqual(['turn:1', 'finished:1', 'turn:2', 'finished:2']);
    });
    it('usage alone never fabricates a successful end before the typed failure arrives', async () => {
        const s = await open(); s.session.deliver('first', 'you'); s.usage();
        await Promise.resolve();
        expect(s.session.turnState).toBe('working');
        expect(s.counts()).toEqual(['turn:1']);
        s.end({ turnId: 'turn-1', stopReason: null, isError: true, raw: 'provider failure' });
        expect(s.session.turnState).toBe('failed');
        expect(s.counts()).toEqual(['turn:1']);
    });
    it('the deferred production driver forwards the prompt id it receives from its inner driver', async () => {
        const factory = deferredDriverFactory(async () => () => ({ start: () => {}, kill: () => {}, cliSessionId: null, prompt: () => 'returned-turn-id' }));
        const driver = factory({ cwd: '.', events: {} });
        driver.start(); await driver.ready;
        expect(driver.prompt('hello') as unknown).toBe('returned-turn-id');
        driver.kill();
    });
    it('CONTROL: a normal typed result still ends its own turn', async () => {
        const s = await open(); s.session.deliver('first', 'you'); s.end({ ...END, turnId: 'turn-1' });
        expect(s.counts()).toEqual(['turn:1', 'finished:1']);
    });
    it('CONTROL: a driver with no ids keeps the established callback contract', async () => {
        const s = await open(); s.session.deliver('first', 'you'); s.end(END);
        expect(s.counts()).toEqual(['turn:1', 'finished:1']);
    });
});
