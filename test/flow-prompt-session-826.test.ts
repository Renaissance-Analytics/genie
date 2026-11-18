import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * TYNN #826, ON THE REAL SESSIONS: what a flow's prompt does in an agent's session.
 *
 * - `deliverFlowPrompt` hands it over NOW the way a typed message goes (`AgentSession.deliver`): Claude takes it inside
 *   its running turn; Codex refuses a second prompt mid-turn, so its session holds it for that turn's end. A later fire of
 *   the same flow drops the earlier one still held: one waits, never two.
 * - `keepFlowPrompt` keeps one no run could take, OWED in the agent's thread (as `recordOwed` keeps a resume prompt), and
 *   `deliverOwed(…, only)` with the flow filter sends what flows are owed at the agent's next run — and nothing the person
 *   left as a draft, which stays theirs to Send or Discard.
 * Fake drivers (no provider runs); the only thing read is what reached each driver's `prompt`.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const BY = 'flow "nightly report"';
const isFlow = (by: string | null): boolean => by !== null && /^flow ".*"$/.test(by);

interface Fake { events: DriverEvents; prompts: string[]; becomeReady: () => Promise<void> }
const fakes = new Map<string, Fake>();
const textOf = (content: unknown): string => (Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? '').join('') : String(content));

/** Claude folds a second prompt into the running turn; Codex REFUSES it mid-turn (prism-acp), so the session holds it. */
const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        let inTurn = false;
        const fake: Fake = { events: options.events, prompts: [], becomeReady: async () => { resolve(); await ready; await Promise.resolve(); } };
        const events = options.events;
        const onTurnEnd = events.onTurnEnd;
        events.onTurnEnd = (outcome) => { inTurn = false; onTurnEnd?.(outcome); };
        fakes.set(record.id, fake);
        return {
            start: () => {},
            prompt: (content: unknown) => {
                if (record.provider === 'codex' && inTurn) throw new Error('a turn is already running');
                inTurn = true;
                fake.prompts.push(textOf(content));
            },
            kill: () => {},
            cancel: () => {},
            cliSessionId: null,
            ...(record.provider === 'codex' ? { ready } : {}),
        };
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-flow-prompt-826-'));
    fakes.clear();
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (provider: 'claude' | 'codex'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider, name: 'atlas' });
const endTurn = (id: AgentId) => fakes.get(id)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
/** A running agent mid-turn on the person's own work. */
async function busy(provider: 'claude' | 'codex'): Promise<AgentRecord> {
    const r = record(provider);
    expect(host.start(r, dir)).toEqual({ ok: true });
    if (provider === 'codex') await fakes.get(r.id)!.becomeReady();
    expect(host.prompt(r.id, 'long job', 'you')).toBe(true);
    expect(host.probe(r.id)?.inTurn).toBe(true);
    return r;
}

describe('deliverFlowPrompt: the flow\'s prompt goes now, as a typed message does (Tynn #826)', () => {
    it('Claude mid-turn: handed into the running turn at once (nothing held)', async () => {
        const r = await busy('claude');
        expect(host.deliverFlowPrompt(r.id, 'tell', BY, null)).toEqual({ id: null });
        expect(fakes.get(r.id)!.prompts.some((p) => p.includes('tell'))).toBe(true);
    });

    it('Codex mid-turn: held for the turn\'s end under an id, and it goes when that turn ends', async () => {
        const r = await busy('codex');
        const handed = host.deliverFlowPrompt(r.id, 'tell', BY, null);
        expect(handed?.id).toEqual(expect.any(String));
        expect(host.isPromptQueued(r.id, handed?.id ?? '')).toBe(true);
        expect(fakes.get(r.id)!.prompts.some((p) => p.includes('tell'))).toBe(false);
        endTurn(r.id);
        expect(fakes.get(r.id)!.prompts.some((p) => p.includes('tell'))).toBe(true);
        expect(host.isPromptQueued(r.id, handed?.id ?? '')).toBe(false);
    });

    it('replacing: a later fire drops the earlier prompt of the same flow still held; one waits', async () => {
        const r = await busy('codex');
        const first = host.deliverFlowPrompt(r.id, 'old numbers', BY, null);
        expect(first?.id).toEqual(expect.any(String));
        const second = host.deliverFlowPrompt(r.id, 'new numbers', BY, first?.id ?? null);
        expect(host.isPromptQueued(r.id, first?.id ?? '')).toBe(false);
        expect(host.isPromptQueued(r.id, second?.id ?? '')).toBe(true);
        endTurn(r.id);
        const sent = fakes.get(r.id)!.prompts.join('\n');
        expect(sent).toContain('new numbers');
        expect(sent).not.toContain('old numbers');
    });

    it('no session: answers null (nothing is pretended delivered)', () => {
        expect(host.deliverFlowPrompt(record('claude').id, 'tell', BY, null)).toBeNull();
    });
});

describe('keepFlowPrompt + the flow delivery at the next run (Tynn #826)', () => {
    it('kept for an agent with no session; its next run\'s flow delivery sends it', async () => {
        const r = record('claude');
        await host.keepFlowPrompt(r.id, 'tell', BY);
        host.start(r, dir);
        expect(await host.deliverOwed(r.id, undefined, isFlow)).toBe(1);
        expect(fakes.get(r.id)!.prompts.some((p) => p.includes('tell'))).toBe(true);
    });

    it('CONTROL: the person\'s draft is NOT sent by the flow delivery; the Restart delivery (no filter) sends it', async () => {
        const r = record('claude');
        await host.recordOwed(r.id, 'my own draft', 'you');
        await host.keepFlowPrompt(r.id, 'tell', BY);
        host.start(r, dir);
        expect(await host.deliverOwed(r.id, undefined, isFlow)).toBe(1);
        expect(fakes.get(r.id)!.prompts.join('\n')).not.toContain('my own draft');
        endTurn(r.id);
        expect(await host.deliverOwed(r.id)).toBe(1);
        expect(fakes.get(r.id)!.prompts.join('\n')).toContain('my own draft');
    });

    it('kept twice by one flow: only the later is owed (one waits, never two)', async () => {
        const r = record('claude');
        await host.keepFlowPrompt(r.id, 'old numbers', BY);
        await host.keepFlowPrompt(r.id, 'new numbers', BY);
        host.start(r, dir);
        expect(await host.deliverOwed(r.id, undefined, isFlow)).toBe(1);
        const sent = fakes.get(r.id)!.prompts.join('\n');
        expect(sent).toContain('new numbers');
        expect(sent).not.toContain('old numbers');
    });

    it('a prompt Codex held when the agent stopped is owed, and the flow delivery at the next run sends it', async () => {
        const r = await busy('codex');
        host.deliverFlowPrompt(r.id, 'tell', BY, null);
        host.stop(r.id);
        await host.ended(r.id);
        expect(host.start(r, dir)).toEqual({ ok: true });
        await fakes.get(r.id)!.becomeReady();
        expect(await host.deliverOwed(r.id, undefined, isFlow)).toBe(1);
        expect(fakes.get(r.id)!.prompts.some((p) => p.includes('tell'))).toBe(true);
    });
});
