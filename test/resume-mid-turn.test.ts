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
 * and told to continue; an idle agent is not touched unless `restore_agents_on_launch` restores everyone, and then it
 * is started WITHOUT being prompted. Starts stay three seconds apart, the interrupted first.
 */
describe('who was mid-turn', () => {
    it('is the working agents only — counted, idle / failed / stopped / unknown excluded', () => {
        const agents = [
            { id: 'a', turnState: 'working' }, { id: 'b', turnState: 'idle' }, { id: 'c', turnState: 'working' },
            { id: 'd', turnState: 'failed' }, { id: 'e', turnState: 'stopped' }, { id: 'f', turnState: 'unknown' }, { id: 'g', turnState: null },
        ] as const;
        expect(midTurnAgents(agents)).toEqual(['a', 'c']);
    });
});

describe('the relaunch', () => {
    it('resumes and prompts ONLY the interrupted agents when restore-all is off', () => {
        expect(relaunchPlan({ runningAtQuit: ['a', 'b', 'c'], interruptedAtQuit: ['c', 'a'], restoreAll: false })).toEqual([
            { agentId: 'c', at: 0, resume: true },
            { agentId: 'a', at: 3000, resume: true },
        ]);
    });

    it('with restore-all on, the interrupted first and prompted; the rest started after, NOT prompted, none twice', () => {
        expect(relaunchPlan({ runningAtQuit: ['a', 'b', 'c'], interruptedAtQuit: ['c'], restoreAll: true })).toEqual([
            { agentId: 'c', at: 0, resume: true },
            { agentId: 'a', at: 3000, resume: false },
            { agentId: 'b', at: 6000, resume: false },
        ]);
    });

    it('nothing recorded, nothing started (control)', () => {
        expect(relaunchPlan({ runningAtQuit: [], interruptedAtQuit: [], restoreAll: true })).toEqual([]);
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
