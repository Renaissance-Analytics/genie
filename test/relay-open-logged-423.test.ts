import { describe, expect, it } from 'vitest';
import { DeviceLinkService, type RelayMemberPorts } from '../src/main/device-link-service.js';
import { PopKeypair, type RelayMemberTransport } from '../src/main/relay-member.js';

/*
 * A CONNECT TO ANOTHER MACHINE IS IN THE LOG, WHATEVER BECAME OF IT (Tynn #423). The owner's desktop could reach none of
 * his machines, and its genie-host.log and lifecycle.log held no trace of any attempt: genie-host's relay open handed its
 * outcome to the window and wrote nothing. Each open now says, in genie-host's log, which workstation, how far it got
 * (Tynn's way in, then the relay to the machine) and why it stopped. Never the grant, the relay ticket or a key.
 */
const GRANT = 'eyJhbGciOiJFZERTQSJ9.GRANT-SECRET-PAYLOAD.SIG';
const transport = { send: () => {}, onMessage: () => () => {}, onClose: () => () => {}, close: () => {}, closedBecause: () => null } as unknown as RelayMemberTransport;

function rig(over: Partial<RelayMemberPorts>) {
    const lines: string[] = [];
    const relay = {
        signedIn: () => true,
        keypair: () => PopKeypair.generate(),
        mint: async () => ({ ok: true as const, token: GRANT, relayEndpoint: 'wss://relay.tynn.example', hostPublicKey: 'HOST-KEY' }),
        open: async () => ({ ok: true as const, transport }),
        ...over,
    } as RelayMemberPorts;
    const service = new DeviceLinkService({ tokens: {} as never, socket: () => { throw new Error('no sockets'); }, send: () => {}, log: (l) => lines.push(l), relay });
    return { service, lines };
}

describe('every relay open is logged on the machine that opened it', () => {
    it('Tynn refused the way in: the workstation, the step and Tynn’s words', async () => {
        const r = rig({ mint: async () => ({ ok: false as const, reason: 'Tynn did not give this machine a way in', refusedByTynn: true as const }) });
        expect(await r.service.openRelay('window-1', 'ws_desk')).toMatchObject({ ok: false, stage: 'tynn' });
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0]).toMatch(/ws_desk/);
        expect(r.lines[0]).toMatch(/tynn/i);
        expect(r.lines[0]).toContain('Tynn did not give this machine a way in');
    });

    it('the relay to the machine failed: the workstation, the step and the relay’s words', async () => {
        const r = rig({ open: async () => ({ ok: false as const, reason: 'the relay says the workstation is not connected' }) });
        expect(await r.service.openRelay('window-1', 'ws_desk')).toMatchObject({ ok: false, stage: 'relay' });
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0]).toMatch(/ws_desk/);
        expect(r.lines[0]).toContain('the relay says the workstation is not connected');
    });

    it('it opened: said once, and the grant appears in no line', async () => {
        const r = rig({});
        expect(await r.service.openRelay('window-1', 'ws_desk')).toMatchObject({ ok: true });
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0]).toMatch(/ws_desk/);
        expect(r.lines[0]).toMatch(/open/i);
        for (const line of r.lines) expect(line).not.toContain('GRANT-SECRET');
    });
});
