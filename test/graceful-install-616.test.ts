import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AgentShutdownDrain } from '../src/core/agent-shutdown-drain.js';
import { relaunchPlan } from '../src/core/upgrade-drain.js';
import { hostDrainAgents } from '../src/main/updates-host.js';
import { UpdateHost, type DrainAgentsPort } from '../src/main/updater.js';

afterEach(() => vi.useRealTimers());
async function rig() {
    vi.useFakeTimers();
    let inTurn = true;
    const order: string[] = []; const interrupted: string[][] = []; const running: string[][] = [];
    const probe = () => ({ running: true, turnState: inTurn ? 'working' : 'idle', inTurn });
    const agents = () => [{ id: 'a', name: 'atlas' }];
    const drain = new AgentShutdownDrain({ agents: () => agents().map((a) => ({ ...a, ...probe() })), notify: () => order.push('notify') });
    const port: DrainAgentsPort = {
        ...hostDrainAgents({ agents, probe, writeRunningAtQuit: async (ids) => { order.push('record running'); running.push([...ids]); }, writeInterruptedAtQuit: async (ids) => { order.push('record interrupted'); interrupted.push([...ids]); }, stopAll: async () => { order.push('stop agents'); } }),
        waitForSafe: (reason, progress) => drain.begin(reason, progress), force: () => drain.force(),
    };
    const host = new UpdateHost({
        port: { configure: () => {}, check: async () => ({ version: '2.0.0-beta.62' }), download: async () => {}, prepareInstall: async () => { order.push('prepare installer'); }, quitAndInstall: () => { order.push('install'); } },
        installDir: '/install', ownPid: 1, processes: () => { order.push('scan'); return []; }, kill: () => false,
        agents: port, stopHosted: async () => { order.push('stop hosting'); }, defer: (fn) => fn(),
    });
    await host.check(); await host.download();
    return { host, drain, order, running, interrupted, safe: () => { inTurn = false; } };
}

describe('upgrade and quit use the safe-point gate before recording or stopping (#616)', () => {
    it('an install prepares the helper but records/stops NOTHING until the running turn ends', async () => {
        const r = await rig(); const result = r.host.install();
        await Promise.resolve(); await Promise.resolve();
        expect(r.order).toEqual(['prepare installer', 'notify']);
        expect(r.host.state().installing).toMatchObject({ step: 'waiting', waiting: [{ id: 'a', name: 'atlas' }] });
        r.safe(); await vi.advanceTimersByTimeAsync(250); await result;
        expect(r.running).toEqual([['a']]); expect(r.interrupted).toEqual([[]]);
        expect(r.order.indexOf('record running')).toBeLessThan(r.order.indexOf('stop agents'));
        expect(r.order.slice(-4)).toEqual(['stop agents', 'stop hosting', 'scan', 'install']);
    });

    it('force install names and records the still-running turn, whose restore is once only', async () => {
        const r = await rig(); const result = r.host.install();
        await Promise.resolve(); await Promise.resolve();
        expect(r.order).not.toContain('stop agents');
        expect(r.host.forceDrain()).toBe(true);
        expect((await result)?.report).toMatch(/mid-turn.*atlas|atlas.*mid-turn/i);
        expect(r.interrupted).toEqual([['a']]);
        expect(relaunchPlan({ runningAtQuit: ['a', 'a'], interruptedAtQuit: ['a', 'a'] })).toEqual([{ agentId: 'a', at: 0, resume: true }]);
        expect(r.order.filter((s) => s === 'install')).toHaveLength(1);
    });

    it('quit publishes the same pending names and bound, and does not run the installer or stop sessions early', async () => {
        const r = await rig(); let ended = false;
        const result = r.host.prepareQuit().then((outcome) => { ended = true; return outcome; });
        await Promise.resolve(); expect(ended).toBe(false);
        expect(r.host.state().installing).toMatchObject({ step: 'waiting', reason: 'quit', waiting: [{ id: 'a', name: 'atlas' }] });
        expect(r.order).toEqual(['notify']);
        r.safe(); await vi.advanceTimersByTimeAsync(250);
        expect(await result).toMatchObject({ interrupted: [], forced: false });
        expect(r.order).not.toContain('install'); expect(r.order).not.toContain('stop agents');
    });

    it('the real quit entry awaits safe-point preparation before its final shutdown record', () => {
        const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        const recordBranch = source.slice(source.indexOf("if (step === 'record')"), source.indexOf("if (step === 'pass')"));
        expect(recordBranch).toMatch(/prepareQuit[\s\S]*recordShutdownNow/);
        expect(source).toMatch(/quitPreparation/); // A repeated before-quit cannot bypass an in-flight preparation.
    });
});
