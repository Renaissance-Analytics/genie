import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { decideConnectLink } from '../src/core/connect-link.js';
import { CONNECT_WORKSTATIONS_ACTION, OPEN_SHARE_LINK_ACTION, connectPaletteActions } from '../src/core/connect-machine.js';
import { DeviceLinkService, type RelayMemberPorts } from '../src/main/device-link-service.js';
import { PopKeypair, type RelayMemberTransport } from '../src/main/relay-member.js';
import { shareLinksOver } from '../src/main/tynn-share-links.js';

/*
 * SHARE LINKS ON A DRONE INSTALL (Tynn #963; the owner, beta.65: "shared links aren't working at all. Clients that are
 * logged into tynn are showing that tynn is not logged in on the share link screen. It's on a drone install").
 *
 * Every step reads genie-host's own Tynn account (a window's account is its replica). Two things failed on a drone:
 *  1. Genie refused the drone locally before Tynn was asked: the pasted link (decideConnectLink), the Command Window's
 *     "Open a share link…", and the relay dial a share link opens (DeviceLinkService.openRelay). A share link is the
 *     one way a drone opens another host; the owner: remote access is never refused any feature. Tynn decides the grant.
 *  2. The share screen's list / make / revoke: Tynn answers a drone's call with the 404 it gives every refusal, and Genie
 *     said "sign in to Tynn" to a person who IS signed in. The role is read again and the words say what is true.
 * Hosts and ids are fixtures.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const TYNN = 'https://tynn.example';

describe('a drone opens a share link (Tynn decides, not a local gate)', () => {
    it('a pasted invite or workstation link is decided on a drone as on a pilot', () => {
        expect(decideConnectLink(`${TYNN}/invites/accept/tok_1`, TYNN, 'drone')).toEqual({ ok: true, link: { kind: 'invite', url: `${TYNN}/invites/accept/tok_1` } });
        expect(decideConnectLink('genie://workstation/open?id=ws_1', TYNN, 'drone')).toEqual({ ok: true, link: { kind: 'workstation', workstationId: 'ws_1' } });
        // Control: signed out is still told to sign in (the host check stays).
        expect(decideConnectLink(`${TYNN}/invites/accept/tok_1`, null, 'drone')).toMatchObject({ ok: false, note: expect.stringMatching(/Sign in to Tynn/) });
    });

    it('the Command Window offers a drone "Open a share link…", and its own workstations too since Tynn #423', () => {
        expect(connectPaletteActions('drone')).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
        expect(connectPaletteActions('pilot')).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
    });

    it('the relay dial a share link opens asks Tynn for the grant, whatever role genie-host read', async () => {
        const minted: string[] = [];
        const transport = { send: () => {}, onMessage: () => () => {}, onClose: () => () => {}, close: () => {}, closedBecause: () => null } as unknown as RelayMemberTransport;
        const relay = {
            signedIn: () => true,
            // What genie-host used to hand in on a drone: a local refusal before Tynn was asked.
            refusal: () => 'This workstation is a drone: it cannot browse or open other workstations.',
            keypair: () => PopKeypair.generate(),
            mint: async (workstationId: string) => { minted.push(workstationId); return { ok: true as const, token: 'GRANT', relayEndpoint: 'wss://relay.tynn.example', hostPublicKey: 'HOST-KEY' }; },
            open: async () => ({ ok: true as const, transport }),
        } as unknown as RelayMemberPorts;
        const service = new DeviceLinkService({ tokens: {} as never, socket: () => { throw new Error('no sockets'); }, send: () => {}, log: () => {}, relay });
        expect(await service.openRelay('window-1', 'ws_shared')).toMatchObject({ ok: true });
        expect(minted).toEqual(['ws_shared']);
        // genie-host no longer hands the relay a role refusal at all.
        expect(code('src/main/genie-host.ts')).not.toMatch(/connectOutRefusal\(/);
    });
});

describe('the share screen on a drone says what is true, not "sign in"', () => {
    const tynn404 = async () => ({ ok: false, status: 404, json: async () => ({}) });

    it('Tynn’s 404 with the role read again as drone: the drone is named, and signing in is not suggested', async () => {
        const reread = vi.fn(async () => 'drone' as const);
        const shares = shareLinksOver({ request: tynn404, workstation: () => 'ws_drone', rereadRole: reread });
        for (const out of [await shares.list(null), await shares.mint({ workspaceId: null, capability: 'control', expiresInDays: 7 }), await shares.revoke('l1')]) {
            expect(out.ok).toBe(false);
            const reason = (out as { reason: string }).reason;
            expect(reason).toMatch(/drone/);
            expect(reason).not.toMatch(/sign in/i);
            // Only {ok, reason} reaches the window.
            expect(Object.keys(out).sort()).toEqual(['ok', 'reason']);
        }
        expect(reread).toHaveBeenCalled();
    });

    it('control: a 404 while Tynn says pilot still says to sign in; a 500 is not re-read', async () => {
        const reread = vi.fn(async () => 'pilot' as const);
        const shares = shareLinksOver({ request: tynn404, workstation: () => 'ws_pilot', rereadRole: reread });
        expect(await shares.list(null)).toEqual({ ok: false, reason: 'Tynn did not let this Genie list share links: sign in to Tynn' });
        const reread500 = vi.fn(async () => 'drone' as const);
        const failing = shareLinksOver({ request: async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) }), workstation: () => 'ws_x', rereadRole: reread500 });
        expect(await failing.list(null)).toEqual({ ok: false, reason: 'boom' });
        expect(reread500).not.toHaveBeenCalled();
    });

    it('genie-host re-reads the role for its share links', () => {
        expect(code('src/main/genie-host.ts')).toMatch(/shareLinksOver\(\{[\s\S]{0,600}rereadRole:/);
    });
});
