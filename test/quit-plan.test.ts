import { describe, expect, it } from 'vitest';
import { quitAnswer, quitPlan } from '../src/core/quit.js';

/**
 * QUIT CONFIRMATION (§6.5) — defaults to the SAFE thing. With nothing running, Genie just quits.
 * With agents or terminals live, it asks, names what would end, and the default answer is Cancel;
 * when detached terminals are on, the terminals survive a quit and the message says so, but live
 * agents still make it ask (an agent session ends with the app — §2.5).
 */

describe('quitPlan', () => {
    it('nothing running → no confirmation', () => {
        expect(quitPlan({ runningAgents: [], liveTerminals: 0 })).toEqual({ confirm: false });
    });

    it('live agents and terminals → confirm, Cancel by default, naming what ends', () => {
        expect(quitPlan({ runningAgents: ['atlas', 'bolt'], liveTerminals: 3 })).toEqual({
            confirm: true,
            defaultChoice: 'cancel',
            title: 'Quit Genie?',
            message: '2 agents are running (atlas, bolt) and 3 terminals are open. Quitting ends the agents’ sessions and closes the terminals.',
            buttons: ['Cancel', 'Quit'],
        });
    });
});

/**
 * QUIT KEEPS THE HOST (the host split, P1b; the owner's decision 5). With genie-host running the agents, a quit asks two
 * answers: "Just close the UI" (the host keeps what runs) or "Shut down everything". Cancel stays the default. With
 * nothing for the host to keep, nothing is asked: the quit shuts down, as before.
 */
describe('quitPlan with genie-host', () => {
    const three = ['Cancel', 'Just close the UI', 'Shut down everything'];

    it('an armed flow or a scheduled task alone asks too: the host keeps it, and a shutdown stops it firing', () => {
        expect(quitPlan({ runningAgents: [], liveTerminals: 0, host: { keptProcesses: 0, armedFlows: 1, scheduledTasks: 0 } })).toMatchObject({
            confirm: true,
            message: '1 flow is armed. Just close the UI and it keeps running, and Genie stays in the tray. Shut down everything stops it firing.',
            buttons: three,
        });
        expect(quitPlan({ runningAgents: [], liveTerminals: 0, host: { keptProcesses: 0, armedFlows: 2, scheduledTasks: 2 } })).toMatchObject({
            confirm: true,
            message: '2 flows are armed and 2 tasks are scheduled. Just close the UI and they keep running, and Genie stays in the tray. Shut down everything stops the flows firing and stops the tasks firing.',
        });
    });

    it('nothing for the host to keep → no question', () => {
        expect(quitPlan({ runningAgents: [], liveTerminals: 0, host: { keptProcesses: 0, armedFlows: 0, scheduledTasks: 0 } })).toEqual({ confirm: false });
    });

    it('agents, terminals and kept processes → the two answers, Cancel by default, naming what each does', () => {
        expect(quitPlan({ runningAgents: ['atlas', 'bolt'], liveTerminals: 3, host: { keptProcesses: 2, armedFlows: 0, scheduledTasks: 0 } })).toEqual({
            confirm: true,
            defaultChoice: 'cancel',
            title: 'Quit Genie?',
            message: '2 agents are running (atlas, bolt), 3 terminals are open and 2 kept processes are running. Just close the UI and they keep running, and Genie stays in the tray. Shut down everything ends the agents’ sessions, closes the terminals and stops the processes.',
            buttons: three,
        });
    });

    it('a kept process alone asks too (the host keeps a site running), and terminals are kept', () => {
        expect(quitPlan({ runningAgents: [], liveTerminals: 0, host: { keptProcesses: 1, armedFlows: 0, scheduledTasks: 0 } })).toMatchObject({
            confirm: true,
            message: '1 kept process is running. Just close the UI and it keeps running, and Genie stays in the tray. Shut down everything stops it.',
            buttons: three,
        });
        expect(quitPlan({ runningAgents: ['atlas'], liveTerminals: 1, host: { keptProcesses: 0, armedFlows: 0, scheduledTasks: 0 } })).toMatchObject({
            confirm: true,
            message: '1 agent is running (atlas) and 1 terminal is open. Just close the UI and they keep running, and Genie stays in the tray. Shut down everything ends its session and closes it.',
            buttons: three,
        });
    });
});

describe('quitAnswer', () => {
    it('maps the dialog’s button to the answer; anything else (Esc, closed) is Cancel', () => {
        const host = quitPlan({ runningAgents: ['atlas'], liveTerminals: 0, host: { keptProcesses: 0, armedFlows: 0, scheduledTasks: 0 } });
        const old = quitPlan({ runningAgents: ['atlas'], liveTerminals: 0 });
        if (!host.confirm || !old.confirm) throw new Error('both ask');
        expect([0, 1, 2, -1, 9].map((i) => quitAnswer(host, i))).toEqual(['cancel', 'close-ui', 'shut-down', 'cancel', 'cancel']);
        expect([0, 1, 2].map((i) => quitAnswer(old, i))).toEqual(['cancel', 'shut-down', 'cancel']);
    });
});
