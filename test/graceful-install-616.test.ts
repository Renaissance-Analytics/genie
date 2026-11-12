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
    let held = false;
    let scanFails = false;
    let installThrows = false;
    const order: string[] = []; const interrupted: string[][] = []; const running: string[][] = [];
    const probe = () => ({ running: true, turnState: inTurn ? 'working' : 'idle', inTurn });
    const agents = () => [{ id: 'a', name: 'atlas' }];
    const drain = new AgentShutdownDrain({ agents: () => agents().map((a) => ({ ...a, ...probe() })), notify: () => order.push('notify'), hold: () => { held = true; }, release: () => { held = false; } });
    const port: DrainAgentsPort = {
        ...hostDrainAgents({ agents, probe, writeRunningAtQuit: async (ids) => { order.push('record running'); running.push([...ids]); }, writeInterruptedAtQuit: async (ids) => { order.push('record interrupted'); interrupted.push([...ids]); }, stopAll: async () => { order.push('stop agents'); } }),
        waitForSafe: (reason, progress) => drain.begin(reason, progress), force: () => drain.force(), release: () => drain.release(),
    };
    const host = new UpdateHost({
        port: { configure: () => {}, check: async () => ({ version: '2.0.0-beta.62' }), download: async () => {}, prepareInstall: async () => { order.push('prepare installer'); }, quitAndInstall: () => { if (installThrows) throw new Error('installer failed'); order.push('install'); } },
        installDir: '/install', ownPid: 1, processes: () => { if (scanFails) throw new Error('scan failed'); order.push('scan'); return []; }, kill: () => false,
        agents: port, stopHosted: async () => { order.push('stop hosting'); }, defer: (fn) => fn(),
    });
    await host.check(); await host.download();
    return { host, drain, order, running, interrupted, safe: () => { inTurn = false; }, working: () => { inTurn = true; }, held: () => held, failScan: (value: boolean) => { scanFails = value; }, failInstall: () => { installThrows = true; } };
}

describe('upgrade and quit use the safe-point gate before recording or stopping (#616)', () => {
    it('a failed install after the wait releases the hold and makes the downloaded install retryable', async () => {
        const r = await rig(); r.failScan(true);
        const pending = r.host.install()!;
        await Promise.resolve(); await Promise.resolve();
        expect(r.held()).toBe(true);
        const observed = pending.then((value) => value, () => null);
        r.safe(); await vi.advanceTimersByTimeAsync(250); await observed;
        expect(r.held()).toBe(false);
        expect(r.host.state().phase).not.toBe('installing');
        r.failScan(false); r.working();
        const retry = r.host.install(); expect(retry).not.toBeNull();
        await Promise.resolve(); await Promise.resolve();
        expect(r.host.state().installing?.step).toBe('waiting');
        r.safe(); await vi.advanceTimersByTimeAsync(250); await retry;
    });

    it('an installer which throws after the drain leaves a usable host, not an installing phase and permanent hold', async () => {
        const r = await rig(); r.failInstall();
        const pending = r.host.install()!;
        const observed = pending.then((value) => value, () => null);
        r.safe(); await vi.advanceTimersByTimeAsync(250); await observed;
        expect(r.held()).toBe(false);
        expect(r.host.state().phase).not.toBe('installing');
    });

    it('when a prepared quit is abandoned on a surviving host, recovery restores its prior updater phase and releases work', async () => {
        const r = await rig(); const pending = r.host.prepareQuit();
        expect(r.held()).toBe(true);
        r.safe(); await vi.advanceTimersByTimeAsync(250); await pending;
        r.host.cancelDrain();
        expect(r.held()).toBe(false);
        expect(r.host.state().phase).toBe('downloaded');
        r.working(); let done = false;
        const next = r.host.prepareQuit().then(() => { done = true; });
        await Promise.resolve(); expect(done).toBe(false);
        r.host.forceDrain(); await next; r.host.cancelDrain();
    });

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
