import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hostActivityOf } from '../src/core/host-activity.js';

/*
 * WHAT THE HOST RUNS, FOR THE LAUNCHER'S TRAY (Tynn #1058 L5): `engine.activity`. "Shut down everything?" in the launcher's
 * window names everything that would stop, so the count has every kind the client's tray counted before L5
 * (core/tray-only.ts): agents (named), terminals, kept processes, services, armed flows, scheduled tasks, the Browser.
 */
describe('hostActivityOf', () => {
    it('counts every kind that stops: agents by name, terminals, processes, services, what waits on the clock, the Browser', () => {
        const a = hostActivityOf({
            running: [{ name: 'genie' }, { name: 'tynn' }],
            summary: { terminals: [{}], processes: ['queue', 'vite', 'php'], services: ['mysql'] },
            flows: [{ armed: true }, { armed: false }, { armed: true }],
            kept: [{ wanted: true, schedule: { every: 60 } }, { wanted: false, schedule: { every: 60 } }, { wanted: true }],
            browserUp: true,
            needsYou: 4,
        });
        expect(a).toEqual({ agents: 2, agentNames: ['genie', 'tynn'], terminals: 1, processes: 3, services: 1, armedFlows: 2, scheduledTasks: 1, browser: true, needsYou: 4 });
    });

    it('nothing running is all zero, and a paused task or a plain kept process waits on no clock', () => {
        const a = hostActivityOf({ running: [], summary: { terminals: [], processes: [], services: [] }, flows: [{ armed: false }], kept: [{ wanted: false, schedule: {} }, { wanted: true }], browserUp: false, needsYou: 0 });
        expect(a).toEqual({ agents: 0, agentNames: [], terminals: 0, processes: 0, services: 0, armedFlows: 0, scheduledTasks: 0, browser: false, needsYou: 0 });
    });

    it('genie-host answers engine.activity with it, from its own lists: flows, the process book, the Browser service', () => {
        const src = readFileSync('src/main/genie-host.ts', 'utf8');
        const at = src.indexOf('activity: () => hostActivityOf({');
        expect(at).toBeGreaterThan(-1);
        const call = src.slice(at, src.indexOf('}),', at));
        expect(call).toMatch(/flows: hostFlows\.list\(\),/);
        expect(call).toMatch(/kept: hostBook\.kept\(\),/);
        expect(call).toMatch(/browserUp: browserService\.up,/);
        expect(call).toMatch(/summary: hostSummary\.now\(\),/);
        // The Deck badge's own number, from this host's own Deck.
        expect(call).toMatch(/needsYou: needsYouCount\(featureDeckItems\(\)\),/);
        expect(readFileSync('src/main/session-engine-server.ts', 'utf8')).toMatch(/case 'engine\.activity':\s*\n\s*if \(!this\.#options\.activity\) throw new Error\('This host does not say what it runs\.'\);\s*\n\s*return this\.#options\.activity\(\);/);
    });
});
