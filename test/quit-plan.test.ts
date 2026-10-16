import { describe, expect, it } from 'vitest';
import { quitPlan } from '../src/core/quit.js';

/**
 * QUIT CONFIRMATION (§6.5) — defaults to the SAFE thing. With nothing running, Genie just quits.
 * With agents or terminals live, it asks, names what would end, and the default answer is Cancel;
 * when detached terminals are on, the terminals survive a quit and the message says so, but live
 * agents still make it ask (an agent session ends with the app — §2.5).
 */

describe('quitPlan', () => {
    it('nothing running → no confirmation', () => {
        expect(quitPlan({ runningAgents: [], liveTerminals: 0, detachedTerminals: false })).toEqual({ confirm: false });
    });

    it('live agents and terminals → confirm, Cancel by default, naming what ends', () => {
        expect(quitPlan({ runningAgents: ['atlas', 'bolt'], liveTerminals: 3, detachedTerminals: false })).toEqual({
            confirm: true,
            defaultChoice: 'cancel',
            title: 'Quit Genie?',
            message: '2 agents are running (atlas, bolt) and 3 terminals are open. Quitting ends the agents’ sessions and closes the terminals.',
            buttons: ['Cancel', 'Quit'],
        });
    });

    it('detached terminals survive a quit and the message says so; agents alone still ask', () => {
        expect(quitPlan({ runningAgents: [], liveTerminals: 2, detachedTerminals: true })).toEqual({ confirm: false });
        expect(quitPlan({ runningAgents: ['atlas'], liveTerminals: 2, detachedTerminals: true })).toMatchObject({
            confirm: true,
            defaultChoice: 'cancel',
            message: '1 agent is running (atlas). Quitting ends its session; the 2 open terminals keep running detached and rejoin next launch.',
        });
        expect(quitPlan({ runningAgents: [], liveTerminals: 1, detachedTerminals: false })).toMatchObject({ confirm: true, message: '1 terminal is open. Quitting closes it.' });
    });
});
