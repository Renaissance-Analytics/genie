import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { headroomFromMeta, RATE_LIMIT_META, type Headroom, type LimitWindow } from '../src/core/headroom.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { PromptBlock } from '../src/core/prompt-content.js';
import type { CarryOver } from '../src/core/carry-over.js';
import { SOURCE_NOTICE_NOW, sourceRateLimitNotice, type SourceProvider } from './fixtures/rate-limit-source.js';

const warning = (x: number) => `You have ${x}% until you hit your rate limit. Reduce the size of your work per turn to minimize loss`;
const load = async () => { const file: string = '../src/core/headroom.js'; return import(file); };
const noTree: ProcessTree = { snapshot: () => [], killTree: pids => ({ killed: pids.length, refused: false }) };
const dirs: string[] = [], sessions: AgentSession[] = [];
afterEach(async () => {
    for (const session of sessions.splice(0)) { await session.stop(); await session.settled(); }
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const room = (windows: readonly Partial<LimitWindow>[]): Headroom => ({ plan: null, window: '5h', leftPct: 60, resetsAtMs: SOURCE_NOTICE_NOW + 10000, over: false,
    windows: windows.map(w => ({ window: '5h', usedPct: 95, leftPct: 5, resetsAtMs: SOURCE_NOTICE_NOW + 10000, over: false, ...w })) });

it.each(['claude', 'codex'] as const)('%s source-shaped notice warns about the lowest window, even when the binding window is healthy', async provider => {
    const m = await load(), frame = sourceRateLimitNotice(provider), headroom = headroomFromMeta((frame._meta as Record<string, unknown>)[RATE_LIMIT_META]);
    expect(headroom?.leftPct).toBe(60); expect(headroom?.windows.length).toBeGreaterThan(1);
    expect(m.rateLimitWarning(headroom, SOURCE_NOTICE_NOW)).toBe(warning(5));
});
it('includes the exact 10% boundary and floors fractional normalized headroom', async () => {
    const m = await load();
    expect(m.rateLimitWarning(room([{ leftPct: 10 }]), SOURCE_NOTICE_NOW)).toBe(warning(10));
    expect(m.rateLimitWarning(room([{ leftPct: 10.01 }]), SOURCE_NOTICE_NOW)).toBeNull();
    expect(m.rateLimitWarning(room([{ leftPct: 9.99 }]), SOURCE_NOTICE_NOW)).toBe(warning(9));
});
it('says zero at exhaustion, negative remaining values and explicit overage', async () => {
    const m = await load();
    for (const window of [{ leftPct: 0 }, { leftPct: -8 }, { leftPct: 5, over: true }]) expect(m.rateLimitWarning(room([window]), SOURCE_NOTICE_NOW)).toBe(warning(0));
});
it('ignores expired windows individually, including the exact reset instant', async () => {
    const m = await load();
    expect(m.rateLimitWarning(room([{ leftPct: 0, resetsAtMs: SOURCE_NOTICE_NOW }, { leftPct: 8 }]), SOURCE_NOTICE_NOW)).toBe(warning(8));
    expect(m.rateLimitWarning(room([{ leftPct: 0, resetsAtMs: SOURCE_NOTICE_NOW - 1 }, { leftPct: 50 }]), SOURCE_NOTICE_NOW)).toBeNull();
    expect(m.rateLimitWarning(room([{ leftPct: 0, resetsAtMs: SOURCE_NOTICE_NOW }]), SOURCE_NOTICE_NOW)).toBeNull();
});
it('adds nothing for absent, empty, invalid or healthy readings', async () => {
    const m = await load();
    for (const value of [null, room([]), room([{ leftPct: NaN }]), room([{ resetsAtMs: NaN }]), room([{ leftPct: 90 }])]) expect(m.rateLimitWarning(value, SOURCE_NOTICE_NOW)).toBeNull();
});

async function rig(provider: SourceProvider = 'claude', carryOver: CarryOver | null = null) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-rate-warning-')); dirs.push(dir);
    const id = mintAgentId(), store = openDurableStore(dir), wires: Array<string | readonly PromptBlock[]> = [];
    let events: DriverEvents = {}, running = false, refuse = false, now = SOURCE_NOTICE_NOW;
    const factory: SessionDriverFactory = options => { events = options.events; return {
        start: () => { running = true; }, prompt: value => { if (refuse) throw new Error('synthetic provider refusal'); wires.push(value); },
        kill: () => { running = false; }, get running() { return running; }, get cliSessionId() { return null; },
    }; };
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree, clock: () => now, carryOver });
    sessions.push(session); session.start(); await session.settled();
    const rows = async () => { await session.settled(); return (await openAgentThread(store, id).messages()).map(r => r.message as { kind: string; text?: string; message?: string; level?: string; mail?: unknown }); };
    const warnings = async () => (await rows()).filter(r => r.kind === 'notice' && r.message?.startsWith('You have '));
    return { session, wires, rows, warnings, emit: (frame: Record<string, unknown>) => events.onUpdate?.(frame),
        reading: (left = 5, reset = SOURCE_NOTICE_NOW + 3_600_000) => events.onUpdate?.(sourceRateLimitNotice(provider, left, reset)),
        end: (outcome: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: null }) => events.onTurnEnd?.(outcome),
        refuse: (value: boolean) => { refuse = value; }, now: (value: number) => { now = value; } };
}

it.each(['claude', 'codex'] as const)('%s waits for the next input and records a separate Genie warning, preserving the person’s words', async provider => {
    const r = await rig(provider); r.session.prompt('first', 'you'); r.reading(); r.end();
    expect(r.wires).toEqual(['first']); expect(await r.warnings()).toEqual([]);
    r.session.prompt('next user words', 'you');
    expect(String(r.wires[1])).toContain(warning(5)); expect(String(r.wires[1])).toContain('next user words');
    expect(await r.warnings()).toEqual([expect.objectContaining({ kind: 'notice', level: 'warning', message: warning(5) })]);
    expect((await r.rows()).filter(row => row.kind === 'message').map(row => row.text)).toEqual(['first', 'next user words']);
});
it('uses the newest reading once, then rearms only after another turn ends', async () => {
    const r = await rig(); r.session.prompt('first'); r.reading(8); r.end(); r.reading(2);
    r.session.prompt('next'); expect(String(r.wires[1])).toContain(warning(2));
    r.session.prompt('same turn'); expect(String(r.wires[2])).not.toContain('until you hit your rate limit');
    r.reading(3); r.end(); r.session.prompt('another turn');
    expect(String(r.wires[3])).toContain(warning(3)); expect((await r.warnings()).map(row => row.message)).toEqual([warning(2), warning(3)]);
});
it.each(['claude', 'codex'] as const)('%s exhaustion or overage reaches the agent as zero', async provider => {
    const r = await rig(provider); r.session.prompt('first'); r.reading(-8); r.end(); r.session.prompt('next');
    expect(String(r.wires[1])).toContain(warning(0)); expect((await r.warnings()).map(row => row.message)).toEqual([warning(0)]);
});
it('drops a pending warning when the newest reading is healthy', async () => {
    const r = await rig(); r.session.prompt('first'); r.reading(); r.end(); r.reading(60); r.session.prompt('next');
    expect(r.wires[1]).toBe('next'); expect(await r.warnings()).toEqual([]);
});
it('drops a pending warning if its window resets before input arrives', async () => {
    const r = await rig(); r.session.prompt('first'); r.reading(5, SOURCE_NOTICE_NOW + 100); r.end(); r.now(SOURCE_NOTICE_NOW + 100); r.session.prompt('next');
    expect(r.wires[1]).toBe('next'); expect(await r.warnings()).toEqual([]);
});
it('preserves attachment blocks and does not put the warning into the recorded user message', async () => {
    const r = await rig(); r.session.prompt('first'); r.reading(); r.end();
    const content: readonly PromptBlock[] = [{ type: 'text', text: 'file prompt' }, { type: 'resource', resource: { uri: 'synthetic.txt', text: 'synthetic attachment' } }];
    r.session.prompt('file prompt', 'you', { content, attachments: ['synthetic.txt'] });
    const wire = r.wires[1] as readonly PromptBlock[];
    expect(wire[0]).toMatchObject({ type: 'text', text: expect.stringContaining(warning(5)) }); expect(wire.slice(-2)).toEqual(content);
    expect((await r.rows()).filter(row => row.kind === 'message').at(-1)?.text).toBe('file prompt');
});
it('retains the warning when the provider refuses input and consumes it only on acceptance', async () => {
    const r = await rig(); r.session.prompt('first'); r.reading(); r.end(); r.refuse(true);
    expect(() => r.session.prompt('refused')).toThrow('synthetic provider refusal'); expect(await r.warnings()).toEqual([]);
    r.refuse(false); r.session.prompt('accepted'); expect(String(r.wires[1])).toContain(warning(5)); expect((await r.warnings()).length).toBe(1);
});
it('combines pending carry-over with the warning and suppresses the provider echo of both', async () => {
    const r = await rig('claude', { from: 'codex', text: 'Synthetic carried context', turns: 1, of: 1, plan: false });
    r.reading(); r.end(); r.session.prompt('next user words', 'you');
    const wire = String(r.wires[0]); expect(wire).toContain('Synthetic carried context'); expect(wire).toContain(warning(5));
    r.emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: wire } });
    expect((await r.rows()).filter(row => row.kind === 'message').map(row => row.text)).toEqual(['next user words']);
    expect((await r.warnings()).length).toBe(1);
});
it('attaches the warning to mail that waited for turn end, preserving its mail context', async () => {
    const r = await rig('codex'); r.session.prompt('first'); r.reading(); r.refuse(true);
    const mail = [{ id: 'synthetic-mail', from: 'peer', fromName: 'Peer', text: 'synthetic mail body', sentAt: '2026-11-06T12:00:00.000Z' }];
    expect(r.session.deliver('collect your mail', 'genie', null, { mail, retold: true })).toEqual(expect.any(String));
    r.refuse(false); r.end();
    expect(r.wires.length).toBe(2); expect(String(r.wires[1])).toContain(warning(5));
    expect((await r.rows()).some(row => row.kind === 'notice' && row.message === 'collect your mail' && JSON.stringify(row.mail) === JSON.stringify(mail))).toBe(true);
    expect((await r.warnings()).length).toBe(1);
});
it('keeps headroom isolated between agents that share a provider', async () => {
    const a = await rig(), b = await rig(); a.session.prompt('a'); b.session.prompt('b'); a.reading(); a.end(); b.end();
    a.session.prompt('a next'); b.session.prompt('b next');
    expect(String(a.wires[1])).toContain(warning(5)); expect(b.wires[1]).toBe('b next');
});
it('does not warn from a reading until a turn has ended', async () => {
    const r = await rig(); r.reading(); r.session.prompt('first'); expect(r.wires).toEqual(['first']); expect(await r.warnings()).toEqual([]);
});
