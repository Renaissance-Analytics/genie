import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { peerParticipant } from '../src/core/cross-station.js';
import { participantNamer } from '../src/main/feature-personal.js';

/*
 * THE REVIEW OF #2180 (an independent review at 43e90be7): the parts that are wiring and naming.
 *
 * Finding 1, BOOT LOSS: genie-host registered the relay host long before it gave its RemoteHost the cross-station port, so
 * for that whole stretch of its boot it answered another workstation's mail "carries no agent mail", and the sender settled
 * the message as refused forever. The port is now built BEFORE the remote host and handed to it when it is made: there is
 * no stretch in which a call can arrive and find it missing.
 *
 * The nit on participantNamer: a remote agent is shown with its station's NAME, not Tynn's raw id.
 */

const code = (path: string): string => readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

describe('finding 1: the cross-station port exists before the remote host takes a call', () => {
    const host = code('src/main/genie-host.ts');

    it('genie-host builds the cross-station host before it opens the remote host, and hands it in at the open', () => {
        const built = host.indexOf('new CrossStationHost(');
        const opened = host.indexOf('RemoteAccessHost.open(');
        expect(built).toBeGreaterThan(0);
        expect(opened).toBeGreaterThan(0);
        expect(built).toBeLessThan(opened);
        const openCall = host.slice(opened, host.indexOf('\n    });', opened));
        expect(openCall).toMatch(/\bcrossStation\b/);
        expect(host).not.toMatch(/\.setCrossStation\(/); // nothing set later, after calls could arrive
    });

    it('RemoteAccessHost passes the port to the RemoteHost it makes', () => {
        const access = code('src/main/remote-access-host.ts');
        const made = access.slice(access.indexOf('new RemoteHost({'), access.indexOf('});', access.indexOf('new RemoteHost({')));
        expect(made).toMatch(/crossStation/);
    });
});

describe('nit: a remote agent in the inbox is named with its station’s name', () => {
    const A = '01m88dzykbnbx4kwj2ptpje92z';
    const B = '01m88e0vzh4a36rj22h53hfcwr';

    it('mail from it carries the station’s name; mail to it, the name it was sent to', () => {
        const fromA = peerParticipant(A, 'atlas', 'p8x');
        const toB = peerParticipant(B, 'bolt', 'p8x');
        const name = participantNamer([], [
            { from: fromA, to: 'agent_x', origin: { station: A, stationName: 'desk', id: 'm1' } },
            { from: 'agent_x', to: toB, outbound: { station: B, stationName: 'laptop', state: 'queued', attempts: 0 } },
        ]);
        expect(name(fromA)).toBe('atlas@p8x@desk');
        expect(name(toB)).toBe('bolt@p8x@laptop');
    });
});
