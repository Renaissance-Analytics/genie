import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { wireHostMailWake } from '../src/main/host-mail-wake.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { Store } from '../src/main/store.js';

/**
 * MAIL WAKES AN AGENT WITH NO WINDOW (the host split, P3.2; the owner, 2026-10-31: "the person must never have to type for
 * an agent to get its notifications"). The mail wake was the window's: with the UI closed, mail to an idle or stopped agent
 * waited for a window. It is genie-host's now — the inbox, the sessions, the roster and the settings are all here — so a
 * stopped agent is started for its mail and told, under the same refusals a person's start has: an asleep workspace, the
 * agent cap, each said by name and starting nothing.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

interface Fake { prompts: string[]; events: DriverEvents }
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        const fake: Fake = { prompts: [], events: options.events };
        fakes.set(record.id, fake);
        return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(typeof content === 'string' ? content : JSON.stringify(content)); }, kill: () => {}, cliSessionId: null };
    };
    return factory;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); fakes.clear(); });

async function rig(options: { asleep?: boolean; cap?: string; sessionEvents?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'host-wake-'));
    const ws = await mkdtemp(join(tmpdir(), 'host-wake-ws-'));
    const store = new Store(dir);
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas' });
    const other = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'other' });
    await store.writeWorkspaces([{ id: 'ws', path: ws, ...(options.asleep ? { asleep: true } : {}) }]);
    await store.writeAgents([atlas, other]);
    const registry = new HostRegistry(store);
    await registry.refresh();
    const inbox = await InboxStore.open(dir);
    const settings = await SettingsStore.open(dir);
    if (options.cap) await settings.setFor('ws', 'agent_cap', options.cap);
    const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    // A quiet event source models an idle session that sends NO further events to the mail wake.
    const subscribe = options.sessionEvents === false ? vi.spyOn(host, 'subscribe').mockReturnValue(() => {}) : null;
    const log: string[] = [];
    const off = wireHostMailWake({ inbox, host, registry, settings, osaDir: dir, log: (l) => log.push(l) });
    cleanups.push(async () => { off(); subscribe?.mockRestore(); host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await rm(ws, { recursive: true, force: true }); });
    return { inbox, host, atlas, other, log };
}

describe('mail wakes an agent in genie-host', () => {
    it('Tynn #672: IDLE, one refused handoff, then timers alone deliver the actual message within 5 s exactly once', async () => {
        const r = await rig({ sessionEvents: false });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const handOff = vi.spyOn(r.host, 'handOff');
        try {
            expect(r.host.start(r.atlas, process.cwd())).toEqual({ ok: true });
            expect(r.host.prompt(r.atlas.id, 'warm up', 'you')).toBe(true);
            const fake = fakes.get(r.atlas.id)!;
            fake.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
            // Let Cooling finish BEFORE arrival: even its session-change event cannot rescue the refused handoff.
            await vi.advanceTimersByTimeAsync(15_000);
            expect(r.host.probe(r.atlas.id)?.turnState).toBe('idle');
            expect(r.host.probe(r.atlas.id)?.cooling).toBe(false);
            expect(r.host.inTurn(r.atlas.id)).toBe(false);
            expect(r.host.deliverable(r.atlas.id)).not.toBeNull();
            expect(fake.prompts).toEqual(['warm up']);
            await r.host.settled();

            // Refuse exactly ONE handoff, before it reaches the provider; subsequent calls use the real SessionHost.
            handOff.mockImplementationOnce(() => { throw new Error('injected transient handoff refusal'); });
            const text = 'The deployment finished; the requested result is ready.';
            const arrivedAt = Date.now();
            const message = await r.inbox.send({ from: r.other.id, to: r.atlas.id, text });
            expect(handOff).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_500);
            expect(handOff.mock.results[0]?.type).toBe('throw');
            expect(handOff.mock.results[0]?.value).toEqual(new Error('injected transient handoff refusal'));

            // From arrival onward there is NO further mail, input, receive, readiness or turn/session event.
            // Only the clock advances. A timer owned by the real mail wake must make the second attempt.
            await vi.advanceTimersByTimeAsync(3_500);
            expect(Date.now() - arrivedAt).toBe(5_000);
            expect({ handOffAttempts: handOff.mock.calls.length, deliveredPrompts: fake.prompts.slice(1) }).toEqual({
                handOffAttempts: 2,
                deliveredPrompts: [expect.stringContaining(text)],
            });
            // The card IS the message: its sender/body/identity reach the chat as well as the provider, with no nudge.
            expect(fake.prompts.slice(1).join('\n')).not.toMatch(/unread AgentInbox|collect .*agentinbox receive/);
            const deliveredMail = () => r.host.rowsFor(r.atlas.id).flatMap(({ event }) =>
                event.kind === 'message' && event.speaker === 'peer' && event.peerName === 'genie' ? event.mail ?? [] : []);
            expect(deliveredMail()).toEqual([expect.objectContaining({ id: message.id, from: r.other.id, fromName: 'other', text })]);

            // Continue with timers alone: neither another attempt nor a duplicate card/provider prompt may appear.
            await vi.advanceTimersByTimeAsync(10_000);
            expect(handOff).toHaveBeenCalledTimes(2);
            expect(fake.prompts.slice(1)).toEqual([expect.stringContaining(text)]);
            expect(deliveredMail()).toHaveLength(1);
        } finally {
            handOff.mockRestore();
            vi.useRealTimers();
        }
    });

    it('a STOPPED agent is started for its mail and told — with no window and nobody typing', async () => {
        const r = await rig();
        expect(r.host.probe(r.atlas.id as AgentId)).toBeNull(); // CONTROL: not running before the mail
        await r.inbox.send({ from: HUMAN, to: r.atlas.id as AgentId, text: 'the deploy finished' });
        await settle();
        expect(r.host.probe(r.atlas.id as AgentId)?.running).toBe(true);
        expect(fakes.get(r.atlas.id)?.prompts.length ?? 0).toBeGreaterThan(0);
    });

    it('an ASLEEP workspace: nothing is started, and why is said', async () => {
        const r = await rig({ asleep: true });
        await r.inbox.send({ from: HUMAN, to: r.atlas.id as AgentId, text: 'wake up' });
        await settle();
        expect(r.host.probe(r.atlas.id as AgentId)).toBeNull();
        expect(r.log.join('\n')).toMatch(/hibernating/);
    });

    it('at the AGENT CAP: nothing is started, and the cap is named', async () => {
        const r = await rig({ cap: '1' });
        expect(r.host.start(r.other, process.cwd())).toEqual({ ok: true }); // one already running: the cap of 1 is reached
        await r.inbox.send({ from: HUMAN, to: r.atlas.id as AgentId, text: 'one more' });
        await settle();
        expect(r.host.probe(r.atlas.id as AgentId)).toBeNull();
        expect(r.log.join('\n')).toMatch(/cap of 1/);
    });
});
