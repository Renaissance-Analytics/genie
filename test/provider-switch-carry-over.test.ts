import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentOps from '../src/core/agent-ops.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { switchDriver, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';

/**
 * A PROVIDER SWITCH KEEPS THE CONVERSATION (Tynn story #380). The owner: "I should be able to switch providers and models
 * without losing context."
 *
 *  - Each provider keeps ITS native session: switching away parks it, switching back resumes it (the registry used to set
 *    `threadId` to null, dropping it).
 *  - The new provider's first prompt carries the conversation so far (core/carry-over.ts), held on the record and attached
 *    ONCE, above the person's own words. The chat marks it ("Context carried from <provider> (N turns)", expandable);
 *    the ledger never records it as the person's message. A failed send keeps it for the next; a switch again before any
 *    prompt rebuilds it for the new target instead of stacking.
 *  - Switching never writes AGENT.md, and is never refused for a `tuis:` line in it.
 *
 * Fields that do not exist yet are reached loosely ON PURPOSE: on the old code these are red by assertion.
 */
type Loose = Record<string, unknown>;
const loose = (r: unknown) => r as Loose;

let dir: string;
let registry: Registry;
const hosts: SessionHost[] = [];
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-carry-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
});
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });

let t = 0;
const row = (event: StreamEvent): TimedEvent => ({ id: `r${++t}`, event, at: Date.now() - 100_000 + ++t });
const conversation = (): TimedEvent[] => [
    row({ kind: 'turn', n: 1, by: 'you' }),
    row({ kind: 'message', speaker: 'you', peerName: null, text: 'Fix the login bug' }),
    row({ kind: 'message', speaker: 'agent', peerName: null, text: 'Found it: the token is never refreshed.' }),
];

function opsPorts(history: () => readonly TimedEvent[], manifestReads: string[]): AgentOpsPorts {
    const ports = {
        registry: {
            find: (id: string) => registry.find(id as never),
            setProvider: (id: never, provider: never, options: never) => registry.setProvider(id, provider, options),
        },
        host: { stop: () => true, ended: async () => null, probe: () => null, start: () => ({ ok: true }) },
        readManifest: async (record: AgentRecord) => { manifestReads.push(record.name); return '---\nname: atlas\ntuis: [claude]\n---\nYou are atlas.\n'; },
        history: async () => history(),
    };
    return ports as unknown as AgentOpsPorts;
}

describe('each provider keeps its own native session', () => {
    it('switching away parks it; switching back resumes it; the other provider’s is parked in turn — on disk too', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.recordThread(a.id, 'claude-sess-1');
        const toCodex = await registry.setProvider(a.id, 'codex', { keepModel: false });
        expect(toCodex.ok && toCodex.record.threadId).toBeNull(); // never ran on codex
        await registry.recordThread(a.id, 'codex-sess-1');
        const back = await registry.setProvider(a.id, 'claude', { keepModel: false });
        expect(back.ok && back.record.threadId).toBe('claude-sess-1');
        const again = await registry.setProvider(a.id, 'codex', { keepModel: false });
        expect(again.ok && again.record.threadId).toBe('codex-sess-1');
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.find(a.id)).toMatchObject({ provider: 'codex', threadId: 'codex-sess-1' });
        // Control: a MODEL switch is unchanged — the session stays.
        await reopened.setModel(a.id, 'gpt-5.1');
        expect(reopened.find(a.id)?.threadId).toBe('codex-sess-1');
    });
});

describe('the switch', () => {
    it('reads AGENT.md (positive control) but is never refused for its tuis, and writes nothing to it', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.recordThread(a.id, 'claude-sess-1');
        const reads: string[] = [];
        const decision = await switchDriver(opsPorts(conversation, reads), a.id, 'codex');
        expect(reads).toEqual(['atlas']);
        expect(decision).toMatchObject({ ok: true, from: 'claude', to: 'codex' });
        expect(loose(decision)['carried']).toMatchObject({ turns: 1, of: 1, plan: false });
        expect(loose(decision)['left']).toBe('claude-sess-1');
        // Held on the record for the next prompt, headed with the provider it came from.
        const pending = loose(registry.find(a.id))['carryOver'] as { from: string; text: string; turns: number } | undefined;
        expect(pending?.from).toBe('claude');
        expect(pending?.text.startsWith('Conversation so far, from claude:')).toBe(true);
        expect(pending?.text).toContain('Fix the login bug');
        // The message, plain.
        expect(agentOps.switchOutcome('atlas', decision)).toBe('atlas switched claude → codex. Its conversation comes with it (the last 1 turn). Switching back to claude resumes its claude conversation.');
    });

    it('switching again before any prompt REBUILDS the pending carry-over for the new target — never stacks', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.recordThread(a.id, 'claude-sess-1');
        const reads: string[] = [];
        await switchDriver(opsPorts(conversation, reads), a.id, 'codex');
        expect(loose(registry.find(a.id))['carryOver']).toBeDefined();
        // Back to claude at once: nothing happened on codex since the agent left claude, so nothing is carried, and claude resumes its own.
        await switchDriver(opsPorts(conversation, reads), a.id, 'claude');
        expect(registry.find(a.id)?.threadId).toBe('claude-sess-1');
        expect(loose(registry.find(a.id))['carryOver']).toBeUndefined();
    });

    it('nothing on disk names a tuis: line written by a switch (the switch has no AGENT.md writer at all)', async () => {
        const source = await readFile('src/main/agent-ops-host.ts', 'utf8');
        expect(source).not.toMatch(/writeManifest|writeFile|manifestWithTui|recordChoiceInPersona/);
    });
});

const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function host(sent: { resume: string | null; prompts: unknown[] }[], options: { failFirst?: boolean; onCarryOverSent?: (id: string) => void } = {}) {
    let events: DriverEvents = {};
    let failures = options.failFirst ? 1 : 0;
    const driverFor: DriverFor = (_record, _cwd, resume) => ((o: { events: DriverEvents }) => {
        events = o.events;
        const run = { resume, prompts: [] as unknown[] };
        sent.push(run);
        return {
            start: () => {},
            prompt: (p: unknown) => { if (failures > 0) { failures -= 1; throw new Error('the provider refused the prompt'); } run.prompts.push(p); },
            kill: () => {}, get running() { return true; }, get cliSessionId() { return null; },
        };
    }) as unknown as SessionDriverFactory;
    const made = new SessionHost({ userData: dir, driverFor, processTree: tree, ...(options.onCarryOverSent ? { onCarryOverSent: options.onCarryOverSent } : {}) } as never);
    hosts.push(made);
    return { host: made, end: (stopReason = 'end_turn') => events.onTurnEnd?.({ stopReason } as never) };
}
const text = (p: unknown): string => (typeof p === 'string' ? p : JSON.stringify(p));
const carried = { from: 'claude', turns: 2, of: 2, plan: false, text: 'Conversation so far, from claude:\nPerson: earlier words' };

describe('the first prompt after a switch carries it, once', () => {
    it('attached above the person’s words on the first prompt only; the native session resumed; a marker, and no person-message copy in the ledger', async () => {
        const record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'atlas' }), threadId: 'codex-sess-1', carryOver: carried } as AgentRecord;
        const sent: { resume: string | null; prompts: unknown[] }[] = [];
        const cleared: string[] = [];
        const h = host(sent, { onCarryOverSent: (id) => cleared.push(id) });
        h.host.start(record, dir);
        h.host.prompt(record.id, 'Ship it', 'you');
        expect(sent[0]!.resume).toBe('codex-sess-1');
        const first = text(sent[0]!.prompts[0]);
        expect(first.startsWith('Conversation so far, from claude:')).toBe(true);
        expect(first.endsWith('Ship it')).toBe(true);
        h.end();
        await vi.waitFor(() => expect(cleared).toEqual([record.id]));
        // Later prompts in the same run carry nothing.
        h.host.prompt(record.id, 'And the docs', 'you');
        expect(text(sent[0]!.prompts[1])).toBe('And the docs');
        // The chat: the person's message is their words only; the carry-over is a marker with the exact text sent.
        const rows = h.host.rowsFor(record.id);
        const yours = rows.filter((r) => r.event.kind === 'message' && r.event.speaker === 'you').map((r) => (r.event as { text: string }).text);
        expect(yours).toEqual(['Ship it', 'And the docs']);
        const markers = rows.filter((r) => r.event.kind === 'notice' && loose(r.event)['carried'] !== undefined);
        expect(markers).toHaveLength(1);
        expect(loose(markers[0]!.event)['message']).toBe('Context carried from claude (2 turns)');
        expect(loose(loose(markers[0]!.event)['carried'])['text']).toBe(carried.text);
    });

    it('a failed send keeps it pending: the next prompt carries it (COUNTED: cleared once, after the send that went)', async () => {
        const record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'atlas' }), carryOver: carried } as AgentRecord;
        const sent: { resume: string | null; prompts: unknown[] }[] = [];
        const cleared: string[] = [];
        const h = host(sent, { failFirst: true, onCarryOverSent: (id) => cleared.push(id) });
        h.host.start(record, dir);
        expect(() => h.host.prompt(record.id, 'first try', 'you')).toThrow(/refused/);
        expect(cleared).toEqual([]);
        h.host.prompt(record.id, 'second try', 'you');
        expect(text(sent[0]!.prompts[0]).startsWith('Conversation so far, from claude:')).toBe(true);
        h.end();
        await vi.waitFor(() => expect(cleared).toEqual([record.id]));
    });

    it('a cancelled turn keeps it pending too (control: a turn that replied clears it)', async () => {
        const record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'atlas' }), carryOver: carried } as AgentRecord;
        const sent: { resume: string | null; prompts: unknown[] }[] = [];
        const cleared: string[] = [];
        const h = host(sent, { onCarryOverSent: (id) => cleared.push(id) });
        h.host.start(record, dir);
        h.host.prompt(record.id, 'one', 'you');
        h.end('cancelled');
        await new Promise((r) => setTimeout(r, 20));
        expect(cleared).toEqual([]);
        h.host.prompt(record.id, 'two', 'you');
        expect(text(sent[0]!.prompts[1]).startsWith('Conversation so far, from claude:')).toBe(true);
        h.end();
        await vi.waitFor(() => expect(cleared).toEqual([record.id]));
    });
});
