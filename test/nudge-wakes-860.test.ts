import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import { resolveAddress } from '../src/core/inbox.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { hostAgentWake } from '../src/main/host-mail-wake.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { nudgeOnRoster } from '../src/main/scheduled-nudge.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { Store } from '../src/main/store.js';

/**
 * A SCHEDULED NUDGE WAKES ITS AGENT (Tynn #860; the owner's decision, 2026-11-18 18:45Z: "a scheduled nudge WAKES its
 * agent through the host's one wake path, the same as mail (host-mail-wake), respecting safe mode and the wake caps").
 *
 * Before: a nudge to an agent with no running session failed ("stoic@moic-suite is not running") — opening an agent does
 * not start it, and a Genie restart leaves agents unstarted, so a 10-minute nudge failed every time. Now the nudge starts
 * the agent through the same wake mail uses — refused by name in safe mode, in a hibernating workspace, or at the
 * workspace's agent cap, starting nothing — and its prompt is held until the new session is ready, then delivered once.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/** A provider that becomes ready only when the test says so; what it was prompted with, per agent. */
const prompts = new Map<string, string[]>();
const readyNow = new Map<string, () => void>();
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = () => {
        let resolve!: () => void;
        const ready = new Promise<void>((r) => { resolve = r; });
        readyNow.set(record.id, resolve);
        prompts.set(record.id, []);
        return { start: () => {}, ready, prompt: (content: unknown) => { prompts.get(record.id)!.push(typeof content === 'string' ? content : JSON.stringify(content)); }, kill: () => {}, cliSessionId: null };
    };
    return factory;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); prompts.clear(); readyNow.clear(); });

async function rig(options: { asleep?: boolean; cap?: string; safeMode?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nudge-wake-'));
    const ws = await mkdtemp(join(tmpdir(), 'nudge-wake-ws-'));
    const store = new Store(dir);
    const stoic = agentRecord({ id: mintAgentId(), workspaceId: 'moic-suite', provider: 'claude', name: 'stoic' });
    const other = agentRecord({ id: mintAgentId(), workspaceId: 'moic-suite', provider: 'claude', name: 'other' });
    await store.writeWorkspaces([{ id: 'moic-suite', path: ws, ...(options.asleep ? { asleep: true } : {}) }]);
    await store.writeAgents([stoic, other]);
    const registry = new HostRegistry(store);
    await registry.refresh();
    const settings = await SettingsStore.open(dir);
    if (options.cap) await settings.setFor('moic-suite', 'agent_cap', options.cap);
    const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    const start = vi.spyOn(host, 'start');
    const wake = hostAgentWake({ host, registry, settings, osaDir: dir, safeMode: () => options.safeMode === true });
    const nudge = (address: string, text: string) => nudgeOnRoster({
        resolve: (a) => resolveAddress(a, registry.listAgents(), registry.workspaceSlugs()),
        deliver: (id, t, by) => host.deliver(id, t, by),
        wake,
    }, address, text, 'stoic ticket watch');
    cleanups.push(async () => { start.mockRestore(); host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await rm(ws, { recursive: true, force: true }); });
    return { host, stoic, other, start, nudge };
}

const running = (host: SessionHost, id: string) => host.probe(id as AgentId)?.running === true;

describe('a scheduled nudge wakes its agent (Tynn #860)', () => {
    it('an agent that is not started is STARTED, and the nudge is delivered once it is ready — exactly once', async () => {
        const r = await rig();
        expect(running(r.host, r.stoic.id)).toBe(false);
        expect(await r.nudge('stoic@moic-suite', 'check the ticket queue')).toEqual({ ok: true });
        expect(r.start).toHaveBeenCalledTimes(1);
        expect(running(r.host, r.stoic.id)).toBe(true);
        // Held while the provider starts: nothing reaches it before it is ready.
        expect(prompts.get(r.stoic.id)).toEqual([]);
        readyNow.get(r.stoic.id)!();
        await settle();
        expect(prompts.get(r.stoic.id)!.filter((p) => p.includes('check the ticket queue'))).toHaveLength(1);
    });

    it('safe mode: nothing is started by itself — the run fails saying so, and nothing reaches the agent', async () => {
        const r = await rig({ safeMode: true });
        expect(await r.nudge('stoic@moic-suite', 'check the ticket queue')).toEqual({ ok: false, reason: expect.stringMatching(/safe mode/) });
        expect(r.start).not.toHaveBeenCalled();
        expect(running(r.host, r.stoic.id)).toBe(false);
    });

    it('the workspace\'s agent cap: refused with the cap named, nothing started', async () => {
        const r = await rig({ cap: '1' });
        expect(r.host.start(r.other, process.cwd())).toEqual({ ok: true });
        r.start.mockClear();
        expect(await r.nudge('stoic@moic-suite', 'check the ticket queue')).toEqual({ ok: false, reason: expect.stringMatching(/cap of 1/) });
        expect(r.start).not.toHaveBeenCalled();
    });

    it('a hibernating workspace: refused, nothing started', async () => {
        const r = await rig({ asleep: true });
        expect(await r.nudge('stoic@moic-suite', 'check the ticket queue')).toEqual({ ok: false, reason: expect.stringMatching(/hibernat/) });
        expect(r.start).not.toHaveBeenCalled();
    });

    it('CONTROL: an agent already running is not started again; the nudge reaches it', async () => {
        const r = await rig();
        expect(r.host.start(r.stoic, process.cwd())).toEqual({ ok: true });
        readyNow.get(r.stoic.id)!();
        await settle();
        r.start.mockClear();
        expect(await r.nudge('stoic@moic-suite', 'check the ticket queue')).toEqual({ ok: true });
        expect(r.start).not.toHaveBeenCalled();
        await settle();
        expect(prompts.get(r.stoic.id)!.filter((p) => p.includes('check the ticket queue'))).toHaveLength(1);
    });

    it('genie-host gives the scheduler\'s nudge the host\'s one wake, with safe mode', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        const nudge = host.slice(host.indexOf('nudge: (address, text, from) => nudgeOnRoster('), host.indexOf('}, address, text, from),'));
        expect(nudge).toMatch(/wake: \w+/);
        expect(host).toMatch(/const \w+ = hostAgentWake\(\{[^}]*safeMode: safeNow/);
    });
});
