import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commsOf } from '../src/core/comms.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { agentRowFor } from '../src/core/roster.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE DASHBOARD'S COMMS CELL, MEASURED (§4.1): `users` + collaborator count, and the violet dot when a link carried
 * traffic in the last 30 s. Every running agent's row said `collaborators: null` — the cell was blank for everyone,
 * though AgentInbox holds exactly that traffic. Collaborators are the agents a declared agent exchanged mail with
 * since its session started (the human is not a collaborator); the age is the newest link's; each link keeps its
 * count and age for the collaborator reveal. `0` from a running declared agent is a fact, not a gap.
 */
const at = (s: number) => new Date(1_760_000_000_000 + s * 1000).toISOString();
const mail = [
    { from: 'agent_a', to: 'agent_b', sentAt: at(10) },
    { from: 'agent_b', to: 'agent_a', sentAt: at(20) },
    { from: 'agent_c', to: 'agent_a', sentAt: at(50) },
    { from: 'human', to: 'agent_a', sentAt: at(55) },
    { from: 'agent_a', to: 'agent_b', sentAt: at(-100) },
    { from: 'agent_b', to: 'agent_c', sentAt: at(56) },
];

describe('commsOf', () => {
    it('counts the agents it exchanged mail with since the start — the human excluded, older mail excluded', () => {
        expect(commsOf(mail, 'agent_a', 1_760_000_000_000, 1_760_000_000_000 + 60_000)).toEqual({
            collaborators: 2,
            commsAgeSeconds: 10,
            links: [
                { peer: 'agent_c', count: 1, ageSeconds: 10 },
                { peer: 'agent_b', count: 2, ageSeconds: 40 },
            ],
        });
    });

    it('no traffic is a measured nothing: 0 collaborators, no age, no links', () => {
        expect(commsOf(mail, 'agent_z', 1_760_000_000_000, 1_760_000_000_000 + 60_000)).toEqual({ collaborators: 0, commsAgeSeconds: null, links: [] });
    });
});

describe('a running agent\'s row carries its comms', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-comms-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const driverFor: DriverFor = () => ((() => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } })) as SessionDriverFactory);
    const tree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

    it('from the injected reader, scoped to the session start; without a reader it stays null (positive control)', () => {
        const now = 1_760_000_000_000;
        const seen: number[] = [];
        const host = new SessionHost({ userData: dir, driverFor, clock: () => now, processTree: tree, comms: (_id, since) => { seen.push(since); return { collaborators: 2, commsAgeSeconds: 10, links: [{ peer: 'agent_c', count: 1, ageSeconds: 10 }] }; } });
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        host.start(r, dir);
        const row = agentRowFor(r, host.probe(r.id), () => now);
        expect(row).toMatchObject({ collaborators: 2, commsAgeSeconds: 10, links: [{ peer: 'agent_c', count: 1, ageSeconds: 10 }] });
        expect(seen).toEqual([now]);

        const bare = new SessionHost({ userData: dir, driverFor, clock: () => now, processTree: tree });
        bare.start(r, dir);
        expect(agentRowFor(r, bare.probe(r.id), () => now)).toMatchObject({ collaborators: null, commsAgeSeconds: null, links: null });
    });
});
