import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverChat } from '../src/core/chat-send.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriver } from '../src/core/session.js';
import { deferredDriverFactory } from '../src/main/deferred-driver.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { startForWork, startForYourMessage } from '../src/main/start-on-demand.js';

/**
 * Tynn #735 (client onboarding call, beta.63): "a newly created agent seemed to need Start before its first work ran".
 * The rule (q_04ce323c): opening an agent does not start it; its FIRST REAL WORK does. This is the whole road a
 * brand-new agent's first message takes, composed from the real parts as main.ts composes them — the composer's
 * `deliverChat`, the host API's `prompt`, the person's start-on-demand rule, the SessionHost, and Genie's deferred
 * driver (MCP preparation, then the provider) over a provider shaped like prism-acp's ClaudeDriver (`running` = a child
 * that has not exited, set synchronously by `start`). The other tests of this rule fake one of these parts each.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

/** A provider like prism-acp's ClaudeDriver: running once spawned, ready after its handshake, every prompt kept. */
function fakeProvider() {
    const prompts: string[] = [];
    let child = false;
    let handshake!: () => void;
    const ready = new Promise<void>((r) => { handshake = r; });
    const driver: SessionDriver = {
        start() { child = true; },
        prompt(content) { prompts.push(typeof content === 'string' ? content : content.map((b) => ('text' in b ? String(b.text) : '')).join('')); },
        kill() { child = false; },
        get running() { return child; },
        cliSessionId: null,
        ready,
    };
    return { driver, prompts, handshake: () => handshake() };
}

describe('Tynn #735: a brand-new agent’s first message starts it, and its turn runs — no Start pressed', () => {
    let dir: string;
    let host: SessionHost;
    let provider: ReturnType<typeof fakeProvider>;
    let prepared!: () => void;
    let drivers: number;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-735-'));
        provider = fakeProvider();
        drivers = 0;
        const preparation = new Promise<void>((r) => { prepared = r; });
        // Genie's own start: MCP preparation first (the network wait), then the provider (main/deferred-driver.ts).
        const driverFor: DriverFor = () => {
            drivers += 1;
            return deferredDriverFactory(async () => { await preparation; return () => provider.driver; });
        };
        host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    });
    afterEach(async () => { await host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    // Just created with a purpose: the purpose is its persona (AGENT.md, project.json), not a prompt; nothing ran yet.
    const fresh = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'builder' });

    /** main.ts's composition: `startOnDemand`, `startForYours`, and the host API over the SessionHost. */
    function composed(record: AgentRecord, opts: { startsOnDemand: boolean } = { startsOnDemand: true }) {
        const startOnDemand = (r: AgentRecord) => startForWork({ probe: (id) => host.probe(id), start: (x, cwd) => host.start(x, cwd), cwdFor: () => dir, startRefusal: () => null }, r);
        const deps = {
            find: (id: string) => (id === record.id ? record : null),
            cwdFor: () => dir,
            ...(opts.startsOnDemand ? {
                startForWork: startOnDemand,
                startForYourMessage: (r: AgentRecord) => startForYourMessage({
                    startForWork: startOnDemand,
                    needsNewDriver: (id) => host.needsNewDriver(id),
                    restart: async () => ({ ok: false as const, reason: 'not used here' }),
                    notice: (id, message) => host.notice(id, message),
                }, r),
            } : {}),
            host: {
                start: (r: AgentRecord, cwd: string) => host.start(r, cwd),
                stop: (id: AgentRecord['id']) => host.stop(id),
                prompt: (id: AgentRecord['id'], text: string, by: string | null) => host.prompt(id, text, by),
                promptWith: (id: AgentRecord['id'], text: string, attachments: [], by: string | null) => host.promptWith(id, text, attachments, by),
                subscribe: (cb: (id: string) => void) => host.subscribe(cb),
            },
        } as unknown as HostApiDeps;
        const api = buildHostApi(deps);
        let kept = 0;
        // The composer's send (renderer/App.tsx `send`): the host API's `prompt`, a "not running" answer kept as a draft.
        const send = (text: string) => deliverChat({ kind: 'prompt' }, text, [], {
            prompt: async (t) => (await api.invoke('prompt', [record.id, t])) as { ok: boolean; reason?: string | null },
            mail: async () => undefined,
            keepUndelivered: () => { kept += 1; },
        });
        return { api, send, kept: () => kept };
    }

    const sentTimes = (text: string) => provider.prompts.filter((p) => p.includes(text)).length;

    it('the first message from the chat is SENT (never kept as "not running"), starts the agent, and its turn runs', async () => {
        const r = fresh();
        const { send, kept } = composed(r);
        expect(host.probe(r.id)).toBeNull();

        expect(await send('show me what you can do')).toEqual({ kind: 'sent' });
        expect(kept()).toBe(0);
        expect(drivers).toBe(1);

        prepared();
        await vi.waitFor(() => expect(provider.driver.running).toBe(true));
        provider.handshake();
        await vi.waitFor(() => expect(sentTimes('show me what you can do')).toBe(1));
    });

    it('a message sent while it is still preparing waits for the start, then reaches the provider exactly once', async () => {
        const r = fresh();
        const { send, kept } = composed(r);
        expect(await send('first')).toEqual({ kind: 'sent' });
        // Still preparing (no provider yet): a second message is taken too, not refused.
        expect(await send('second')).toEqual({ kind: 'sent' });
        expect(kept()).toBe(0);
        expect(provider.prompts).toEqual([]);

        prepared();
        await vi.waitFor(() => expect(provider.driver.running).toBe(true));
        provider.handshake();
        await vi.waitFor(() => expect(sentTimes('first')).toBe(1));
        await vi.waitFor(() => expect(sentTimes('second')).toBe(1));
        expect(drivers).toBe(1);
    });

    it('opening the new agent starts nothing', async () => {
        const r = fresh();
        const { api } = composed(r);
        expect(await api.invoke('openAgent', [r.id])).toEqual({ ok: true });
        expect(host.probe(r.id)).toBeNull();
        expect(drivers).toBe(0);
    });

    it('CONTROL: without the start-on-demand rule the same first message is kept as not delivered (the reported symptom)', async () => {
        const r = fresh();
        const { send, kept } = composed(r, { startsOnDemand: false });
        expect(await send('show me what you can do')).toEqual({ kind: 'kept' });
        expect(kept()).toBe(1);
        expect(drivers).toBe(0);
        expect(host.probe(r.id)).toBeNull();
    });
});
