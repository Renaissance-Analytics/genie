import { describe, expect, it } from 'vitest';
import { drainableAgents, type DrainTarget } from '../drain';
import { drainRosterFrom } from '../drain-restore';

/**
 * WHO AND WHAT THE DRAIN IS FOR (genie#389).
 *
 * Two questions, and both are pure decisions rather than a walk of live state,
 * because both used to be answered implicitly and both have an answer that is
 * wrong in a way nobody would notice:
 *
 *  - which agents get nudged, and
 *  - which agents, sites and processes go on the RESTORE list.
 *
 * The second is the one with teeth. It is a snapshot of what was RUNNING, and
 * anything broader restarts what the user deliberately switched off (genie#407).
 */

const target = (name: string, over: Partial<DrainTarget> = {}): DrainTarget => ({
    agentId: `ws1:${name}`,
    inboxAgentId: `inbox-${name}`,
    terminalId: `term-${name}`,
    name,
    workspaceId: 'ws1',
    ...over,
});

describe('drainableAgents', () => {
    it('leaves an agent named `general` out entirely', () => {
        // Tynn story #262: *"No agents named general get any nudges or anything
        // so they don't start doing work on restart if any still exist."* A
        // drain row for one would be permanently stuck — it may not be nudged,
        // so it can never answer — and restoring one would start work in an
        // agent nobody meant to create.
        const rows = drainableAgents([target('moic'), target('general')]);
        expect(rows.map((r) => r.name)).toEqual(['moic']);
    });

    it('matches the WHOLE name — `general-purpose` is a real agent', () => {
        const rows = drainableAgents([target('general-purpose'), target('General')]);
        expect(rows.map((r) => r.name)).toEqual(['general-purpose']);
    });

    it('keeps every other agent, including the reserved-but-real ones', () => {
        // POSITIVE CONTROL: a filter that dropped everything would pass the
        // assertions above on its own.
        const rows = drainableAgents([target('tynn'), target('moic'), target('hand')]);
        expect(rows).toHaveLength(3);
    });
});

describe('drainRosterFrom — the restore list is what was RUNNING', () => {
    it('records agents, then sites, then processes', () => {
        const roster = drainRosterFrom({
            agents: [target('moic')],
            sites: [{ siteId: 'ws1/web', label: 'web', workspaceId: 'ws1', running: true }],
            processes: [{ specId: 'proc-queue', label: 'queue', workspaceId: 'ws1', running: true }],
        });

        expect(roster.map((r) => [r.kind, r.ref])).toEqual([
            ['agent', 'ws1:moic'],
            ['site', 'ws1/web'],
            ['process', 'proc-queue'],
        ]);
    });

    it('leaves out a site that was NOT running — and keeps the one that was', () => {
        const roster = drainRosterFrom({
            agents: [],
            sites: [
                { siteId: 'ws1/web', label: 'web', workspaceId: 'ws1', running: true },
                { siteId: 'ws1/api', label: 'api', workspaceId: 'ws1', running: false },
            ],
            processes: [],
        });
        expect(roster.map((r) => r.ref)).toEqual(['ws1/web']);
    });

    it('leaves out a process that was NOT running — and keeps the one that was', () => {
        const roster = drainRosterFrom({
            agents: [],
            sites: [],
            processes: [
                { specId: 'proc-queue', label: 'queue', workspaceId: 'ws1', running: true },
                { specId: 'proc-vite', label: 'vite', workspaceId: 'ws1', running: false },
            ],
        });
        expect(roster.map((r) => r.ref)).toEqual(['proc-queue']);
    });

    it('carries the label the roster shows, so the restore names things', () => {
        const roster = drainRosterFrom({
            agents: [target('moic')],
            sites: [],
            processes: [],
        });
        expect(roster[0]).toEqual({
            kind: 'agent',
            ref: 'ws1:moic',
            label: 'moic',
            workspaceId: 'ws1',
        });
    });
});
