import { describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { hostDrainAgents, installDirOf, UpdatesService, type UpdaterEvent } from '../src/main/updates-host.js';
import { installScreen } from '../src/core/install-screen.js';

/**
 * A HOST UPDATE DRAINS AND SWAPS, AND EVERY AGENT IS RESTORED ONCE (Tynn #414, host split P6). genie-host runs from its own
 * copy, so an installer can replace the install under it: it waits for in-flight turns to reach a safe point (and says who
 * it waits on), records who comes back, stops them, and STAYS until the new window replaces it, which restores each agent
 * once. A swap that fails leaves this host running, and says why.
 */
const lib = (offer = { version: '2.0.0-beta.62', hostHash: 'ffffffffffff', engineProtocol: 3 }): UpdaterPort => ({
    configure: () => {}, check: async () => offer, download: async (p) => { p(100); }, quitAndInstall: () => {},
});

describe('the drain waits for turns to reach a safe point', () => {
    it('settles first, saying who it waits on, then stops the agents', async () => {
        const order: string[] = [];
        const seen: unknown[] = [];
        const host = new UpdateHost({
            port: lib(), installDir: '/opt/genie', ownPid: 10, processes: () => [], kill: () => true, caseInsensitive: false, defer: (fn) => { fn(); },
            running: { build: '2.0.0-beta.61+0123456789ab', protocol: 3 },
            agents: {
                live: () => [{ id: 'a1', name: 'Ada' }],
                settle: async (onWaiting) => { onWaiting(['Ada']); order.push('settle'); },
                stopAll: async () => { order.push('stop'); },
            },
        });
        host.onChange((s) => { if (s.installing?.step === 'turns') seen.push(s.installing.waitingOn); });
        await host.check();
        await host.download();
        await host.install();
        expect(order).toEqual(['settle', 'stop']);
        expect(seen).toContainEqual(['Ada']);
    });

    it('hostDrainAgents waits for every turn in flight, naming them, and gives up at its bound', async () => {
        let t = 0;
        let inTurn = new Set(['a1', 'a2']);
        const waited: string[][] = [];
        const drain = hostDrainAgents({
            agents: () => [{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bo' }],
            probe: (id) => ({ running: true, turnState: 'working', inTurn: inTurn.has(id) }),
            writeRunningAtQuit: async () => {}, writeInterruptedAtQuit: async () => {}, stopAll: async () => {},
            settleMs: 60_000, now: () => t, sleep: async (ms) => { t += ms; if (t >= 1_000) inTurn = new Set(['a2']); },
        });
        await drain.settle!((names) => { waited.push([...names]); });
        expect(waited[0]).toEqual(['Ada', 'Bo']);
        expect(waited.at(-1)).toEqual(['Bo']);
        expect(t).toBeGreaterThanOrEqual(60_000);
    });

    it('CONTROL: with no turn in flight it does not wait', async () => {
        let slept = 0;
        const drain = hostDrainAgents({
            agents: () => [{ id: 'a1', name: 'Ada' }], probe: () => ({ running: true, turnState: 'idle', inTurn: false }),
            writeRunningAtQuit: async () => {}, writeInterruptedAtQuit: async () => {}, stopAll: async () => {},
            now: () => 0, sleep: async () => { slept += 1; },
        });
        await drain.settle!(() => {});
        expect(slept).toBe(0);
    });

    it('records each agent that was running exactly once', async () => {
        const recorded: AgentId[][] = [];
        const drain = hostDrainAgents({
            agents: () => [{ id: 'a1', name: 'Ada' }, { id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bo' }],
            probe: () => ({ running: true, turnState: 'idle', inTurn: false }),
            writeRunningAtQuit: async (ids) => { recorded.push([...ids]); }, writeInterruptedAtQuit: async () => {}, stopAll: async () => {},
        });
        await drain.stopAll();
        expect(recorded).toEqual([['a1', 'a2']]);
    });
});

describe('the swap: genie-host stays until the new window replaces it', () => {
    const run = async (opts: { runsFromCopy: boolean; refuse?: boolean }) => {
        const sent: UpdaterEvent[] = [];
        let exited = 0;
        const service = new UpdatesService({
            host: { installDir: '/opt/genie', ownPid: 10, processes: () => [], kill: () => true, caseInsensitive: false, running: { build: '2.0.0-beta.61+0123456789ab', protocol: 3 }, agents: { live: () => [], stopAll: async () => {} }, stopHosted: async () => {} },
            startHelper: () => {}, defaultLaunch: { file: 'genie', args: ['--updater'] }, windowConnected: () => true,
            exit: () => { exited += 1; }, defer: (fn) => { fn(); }, runsFromCopy: opts.runsFromCopy,
        });
        service.helperLinked('helper', 99, (event) => {
            sent.push(event);
            if (event.kind !== 'request') return;
            const refused = opts.refuse === true && event.op === 'install';
            const value = event.op === 'check' ? { version: '2.0.0-beta.62', hostHash: 'ffffffffffff', engineProtocol: 3 } : refused ? 'the installer was refused' : null;
            queueMicrotask(() => { service.helperCall('reply', [event.id, !refused, value], 'helper'); });
        });
        await service.call('check', [], { window: true });
        await service.call('download', [], { window: true });
        await service.call('install', [42], { window: true });
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
        const install = sent.find((e): e is Extract<UpdaterEvent, { kind: 'request' }> => e.kind === 'request' && e.op === 'install');
        return { wait: install?.wait ?? null, exited, service };
    };

    it('a host on its own copy: the installer waits for the window alone, and the host does not exit', async () => {
        const { wait, exited } = await run({ runsFromCopy: true });
        expect(wait?.pids).toEqual([42]);
        expect(exited).toBe(0);
    });

    it('a swap that fails leaves this host running, and the next window is told why', async () => {
        const { exited, service } = await run({ runsFromCopy: true, refuse: true });
        expect(exited).toBe(0);
        expect(service.takeFailed()?.reason).toMatch(/the installer was refused/);
    });

    it('CONTROL: a host on the install waits with the window, and exits for the installer', async () => {
        const { wait, exited } = await run({ runsFromCopy: false });
        expect(wait?.pids).toEqual([10, 42]);
        expect(exited).toBe(1);
    });
});

describe('the install directory is the install, not the host’s copy', () => {
    it('named by the window (GENIE_INSTALL_EXEC); without it, this executable’s', () => {
        expect(installDirOf({ GENIE_INSTALL_EXEC: '/opt/genie/genie' }, '/home/u/.genie/host/runtime-45/genie')).toBe('/opt/genie');
        expect(installDirOf({}, '/opt/genie/genie')).toBe('/opt/genie');
    });
});

describe('the restart screen says who it waits on', () => {
    it('names the agents whose turn is still in flight', () => {
        expect(installScreen({ phase: 'installing', version: '2.0.0-beta.62', installing: { step: 'turns', agents: 2, left: 2, waitingOn: ['Ada', 'Bo'] } }, true)?.detail)
            .toBe('Waiting for Ada and Bo to finish their turn');
        expect(installScreen({ phase: 'installing', version: '2.0.0-beta.62', installing: { step: 'turns', agents: 1, left: 1, waitingOn: ['Ada'] } }, true)?.detail)
            .toBe('Waiting for Ada to finish its turn');
    });
});
