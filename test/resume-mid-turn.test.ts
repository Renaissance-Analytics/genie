import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESUME_AFTER_RESTART, midTurnAgents, relaunchPlan } from '../src/core/upgrade-drain.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * A TURN CUT OFF BY A SHUTDOWN IS RESUMED (the owner, 2026-10-13): "During an upgrade any agent that is active need to
 * be told to cancel any current activity, it will be resumed after reboot. This should go to ONLY active agents in the
 * middle of turning, not any idle ones and it fires on shutdown of genie, not just an upgrade."
 *
 * At ANY shutdown (quit or upgrade) the agents mid-turn — and only those — are recorded and their turns cancelled
 * (the session ends, which is how a provider's turn is cancelled). At the next launch exactly those are started again
 * and told to continue; every other agent that was running is started too, WITHOUT being prompted — always, there is
 * no setting (the owner, 2026-10-20: "this should happen all of the time, not a god damn setting"). Starts stay three
 * seconds apart, the interrupted first.
 */
describe('who was mid-turn', () => {
    it('is the agents with a turn in flight only (`inTurn`) — counted; no turn, or unknown, excluded (genie#1248)', () => {
        const agents = [
            { id: 'a', inTurn: true }, { id: 'b', inTurn: false }, { id: 'c', inTurn: true },
            { id: 'd', inTurn: undefined }, { id: 'e', inTurn: null },
        ] as const;
        expect(midTurnAgents(agents)).toEqual(['a', 'c']);
    });
});

describe('the relaunch', () => {
    it('prompts ONLY the interrupted agents, in the order recorded', () => {
        expect(relaunchPlan({ runningAtQuit: ['c', 'a'], interruptedAtQuit: ['c', 'a'] })).toEqual([
            { agentId: 'c', at: 0, resume: true },
            { agentId: 'a', at: 3000, resume: true },
        ]);
    });

    it('ALWAYS: the interrupted first and prompted; every other agent that was running started after, NOT prompted, none twice', () => {
        expect(relaunchPlan({ runningAtQuit: ['a', 'b', 'c'], interruptedAtQuit: ['c'] })).toEqual([
            { agentId: 'c', at: 0, resume: true },
            { agentId: 'a', at: 3000, resume: false },
            { agentId: 'b', at: 6000, resume: false },
        ]);
    });

    it('nothing recorded, nothing started (control)', () => {
        expect(relaunchPlan({ runningAtQuit: [], interruptedAtQuit: [] })).toEqual([]);
    });

    it('the prompt says the turn was cancelled by a Genie shutdown and asks to continue', () => {
        expect(RESUME_AFTER_RESTART).toMatch(/shut down/i);
        expect(RESUME_AFTER_RESTART).toMatch(/continue/i);
    });
});

describe('the record', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-midturn-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('persists the interrupted across a reload, filters unknown ids, and is cleared once taken', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'ws', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.markInterruptedAtQuit([a.id, 'agent_never_existed' as never]);
        const again = new Registry(new Store(dir));
        await again.load({ name: 'ws', healthy: true });
        expect(await again.takeInterruptedAtQuit()).toEqual([a.id]);
        expect(await again.takeInterruptedAtQuit()).toEqual([]);
    });
});
