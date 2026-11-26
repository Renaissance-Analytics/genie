import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { OS_AGENT_NAME, OS_WORKSPACE } from '../src/core/os-agent.js';
import {
    deliveryAdmission, findStation, opensFrom, parseStationAddress, peerLabel, peerParticipant, readPeer, rosterOf, sendPlan, stationWord,
    type StationRow,
} from '../src/core/cross-station.js';

/*
 * MAIL BETWEEN THE SAME PERSON'S WORKSTATIONS (P9, Tynn #341/#424; the owner, 2026-11-25: "the only thing we need … is
 * shareable agents, working remote access, and x-station agent inbox"). The pure half: an address naming another station,
 * the participant a remote agent is in this host's inbox, the roster another station may reach, who a host admits mail
 * from, and when a send goes, waits or is refused.
 */

const A = '01m88dzykbnbx4kwj2ptpje92z';
const B = '01m88e0vzh4a36rj22h53hfcwr';
const C = '01m88e1aaaaaaaaaaaaaaaaaaa';
const stations: StationRow[] = [{ id: A, name: 'desk' }, { id: B, name: 'Laptop 2' }, { id: C, name: 'desk' }];

describe('an address naming another workstation', () => {
    it('is name@workspace@station; anything else is not a station address', () => {
        expect(parseStationAddress(`bolt@p8x@${B}`)).toEqual({ name: 'bolt', workspace: 'p8x', station: B });
        expect(parseStationAddress('bolt@p8x@laptop-2')).toEqual({ name: 'bolt', workspace: 'p8x', station: 'laptop-2' });
        // COUNTED: six that are not, six nulls.
        expect(['bolt@p8x', 'bolt', 'a@b@c@d', '@p8x@x', 'bolt@@x', 'bo lt@p@x'].map(parseStationAddress).filter((a) => a === null)).toHaveLength(6);
    });

    it("a station is said by its name when that name is the person's only one of it, else by its id; either finds it", () => {
        expect(stationWord(B, stations)).toBe('laptop-2');
        expect(stationWord(A, stations)).toBe(A); // two workstations are called "desk"
        expect(stationWord('01unknown00000000000000000', stations)).toBe('01unknown00000000000000000');
        expect(findStation('laptop-2', stations)?.id).toBe(B);
        expect(findStation(B, stations)?.id).toBe(B);
        expect(findStation('desk', stations)).toBeNull(); // ambiguous is nobody, never a guess
        expect(findStation('nowhere', stations)).toBeNull();
    });
});

describe('a remote agent in this host’s inbox', () => {
    it('is peer:<station id>:<name>@<workspace>, read back exactly; nothing else reads as one', () => {
        const p = peerParticipant(B, 'bolt', 'p8x');
        expect(p).toBe(`peer:${B}:bolt@p8x`);
        expect(readPeer(p)).toEqual({ station: B, name: 'bolt', workspace: 'p8x' });
        expect([`peer:${B}:bolt`, 'human', 'agent_0123', `peer::bolt@p8x`, `peer:${B}:bo lt@p8x`].map(readPeer).filter((x) => x === null)).toHaveLength(5);
    });

    it('is shown as its full address, the station by its word', () => {
        expect(peerLabel(peerParticipant(B, 'bolt', 'p8x'), stations)).toBe('bolt@p8x@laptop-2');
        expect(peerLabel('human', stations)).toBeNull();
    });
});

describe('the roster another of the owner’s stations may reach', () => {
    const W1 = 'ws_one';
    const W2 = 'ws_two';
    const slugs = new Map([[W1, 'p8x'], [W2, 'other']]);
    const rec = (workspaceId: string, name: string, accessScope: AgentRecord['accessScope']): AgentRecord =>
        agentRecord({ id: mintAgentId(), workspaceId, provider: 'claude', name, accessScope });

    /*
     * THE SAME WORKSPACE ON ANOTHER STATION (the review of #2180, finding 5; the coordinator's ruling): it is the same
     * workspace only when it is the same SHARED workspace, its Tynn project, never because its slug matches. A `self` or
     * `specific` scope opens to its own workspace's shared identity; a workspace linked to no Tynn project opens to nothing
     * across stations.
     */
    const W3 = 'ws_three';
    const shared = (ws: string): string | null => (ws === W1 ? 'tynn:proj_1' : null);
    it('holds every awake workspace’s agents except those whose scope is none, each with the SHARED workspaces that may open to it', () => {
        const roster = rosterOf([rec(W1, 'bolt', 'self'), rec(W1, 'atlas', 'all'), rec(W1, 'shy', 'none'), rec(W1, 'picky', 'specific'), rec(W2, 'sleepy', 'all'), rec(W3, 'loner', 'self')], new Map([...slugs, [W3, 'three']]), new Set([W2]), shared);
        expect(roster).toEqual([
            { name: 'bolt', workspace: 'p8x', opensFrom: ['tynn:proj_1'] },
            { name: 'atlas', workspace: 'p8x', opensFrom: 'all' },
            { name: 'picky', workspace: 'p8x', opensFrom: ['tynn:proj_1'] },
            { name: 'loner', workspace: 'three', opensFrom: [] },
        ]);
    });

    it('the OS agent is genie@system there too, as its address says (run 1125-0504 listed genie@__genie__)', () => {
        const os = agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: OS_AGENT_NAME, accessScope: 'all' });
        expect(rosterOf([os], slugs, new Set(), shared)).toEqual([{ name: OS_AGENT_NAME, workspace: 'system', opensFrom: 'all' }]);
    });

    it('a remote sender opens to an entry only from a shared workspace it allows: a matching slug is not one, and no link matches nothing', () => {
        expect(opensFrom({ name: 'bolt', workspace: 'p8x', opensFrom: ['tynn:proj_1'] }, 'tynn:proj_1')).toBe(true);
        expect(opensFrom({ name: 'bolt', workspace: 'p8x', opensFrom: ['tynn:proj_1'] }, 'tynn:proj_2')).toBe(false);
        expect(opensFrom({ name: 'bolt', workspace: 'p8x', opensFrom: ['tynn:proj_1'] }, 'p8x')).toBe(false); // the slug
        expect(opensFrom({ name: 'bolt', workspace: 'p8x', opensFrom: ['tynn:proj_1'] }, null)).toBe(false);
        expect(opensFrom({ name: 'loner', workspace: 'three', opensFrom: [] }, null)).toBe(false);
        expect(opensFrom({ name: 'atlas', workspace: 'p8x', opensFrom: 'all' }, null)).toBe(true);
    });
});

describe('who a host takes mail from (this slice: the owner’s own workstations only)', () => {
    it('the owner, with control, from a workstation Tynn named in the grant', () => {
        expect(deliveryAdmission({ isOwner: true, readonly: false, station: A })).toBeNull();
    });
    it('refuses a guest, a read-only grant, and an owner whose grant names no workstation, in words', () => {
        expect(deliveryAdmission({ isOwner: false, readonly: false, station: A })).toMatch(/only from its owner's own workstations/);
        expect(deliveryAdmission({ isOwner: true, readonly: true, station: A })).toMatch(/read-only/);
        expect(deliveryAdmission({ isOwner: true, readonly: false, station: null })).toMatch(/does not say which of your workstations/);
    });
});

describe('when a send goes (ONE switch: queue anytime, or only while the person is connected)', () => {
    it('queue: delivered when the station answers, kept and retried when it does not', () => {
        expect(sendPlan('queue', { personConnected: false })).toBe('try-then-queue');
        expect(sendPlan('queue', { personConnected: true })).toBe('try-then-queue');
    });
    it('connected: tried only while the person is connected between the two; otherwise refused and nothing kept', () => {
        expect(sendPlan('connected', { personConnected: true })).toBe('try-once');
        expect(sendPlan('connected', { personConnected: false })).toBe('refuse');
    });
});
