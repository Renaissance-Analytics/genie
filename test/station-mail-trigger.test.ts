import { describe, expect, it } from 'vitest';
import { STATION_MAIL_KIND, matchesStationMailTrigger, type StationMailProps } from '../src/core/station-mail-trigger.js';
import { builtinFlowPackage } from '../src/core/builtin-flow-nodes.js';
import { ensureGenieKinds, GENIE_NODE_KINDS } from '../src/core/flow-canvas.js';

/*
 * A FLOW STARTS ON OUTSIDE COMMUNICATION (the owner, 2026-11-25: "outside communications get their own event for sounds
 * and flows"). `genie/station_mail` is a trigger: each message that crossed to or from another of the owner's
 * workstations, for an agent in the flow's workspace, starts the armed flows whose direction it matches.
 */

const event = (over: Partial<StationMailProps> = {}): StationMailProps => ({
    direction: 'in', station: '01m88e0vzh4a36rj22h53hfcwr', stationName: 'laptop', agentId: 'agent_atlas', workspaceId: 'ws', address: 'bolt@p8x@laptop', messageId: 'msg_1', ...over,
});

describe('which trigger a crossing matches', () => {
    it('any direction by default; "in" or "out" only that way', () => {
        expect(matchesStationMailTrigger({ workspace: 'ws' }, event())).toBe(true);
        expect(matchesStationMailTrigger({ workspace: 'ws', direction: 'any' }, event({ direction: 'out' }))).toBe(true);
        expect(matchesStationMailTrigger({ workspace: 'ws', direction: 'in' }, event({ direction: 'out' }))).toBe(false);
        expect(matchesStationMailTrigger({ workspace: 'ws', direction: 'out' }, event({ direction: 'out' }))).toBe(true);
    });

    it('only the flow’s own workspace’s agents; a station, when named, by its name or id', () => {
        expect(matchesStationMailTrigger({ workspace: 'ws' }, event({ workspaceId: 'other' }))).toBe(false);
        expect(matchesStationMailTrigger({ workspace: 'ws', station: 'Laptop' }, event())).toBe(true);
        expect(matchesStationMailTrigger({ workspace: 'ws', station: '01m88e0vzh4a36rj22h53hfcwr' }, event())).toBe(true);
        expect(matchesStationMailTrigger({ workspace: 'ws', station: 'desk' }, event())).toBe(false);
    });
});

describe('it is on the palette and has an executor', () => {
    it('is a trigger kind Genie offers, by its name', () => {
        ensureGenieKinds();
        expect(GENIE_NODE_KINDS.find((k) => k.name === STATION_MAIL_KIND)).toMatchObject({ category: 'trigger' });
        expect(builtinFlowPackage().contributions.some((e) => (e.payload as { executor?: string }).executor === STATION_MAIL_KIND)).toBe(true);
    });
});
