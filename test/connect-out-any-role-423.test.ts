import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CONNECT_WORKSTATIONS_ACTION, OPEN_SHARE_LINK_ACTION, connectPaletteActions } from '../src/core/connect-machine.js';
import { deviceLinkProtocol, type DeviceLinkProtocolPorts } from '../src/main/device-link-protocol.js';

/*
 * A MACHINE CONNECTS OUT WHATEVER ITS ROLE (Tynn #423; the owner, 2026-11-18: "Every host is effectively a drone and
 * every client a pilot"; 2026-11-24: "I have repeatedly complained about not being able to connect to any machine
 * either on or off my tailnet").
 *
 * Measured in an Azure test VM against tynn.gen and the real relay (genie-cloud 0.1.37), beta.65 and this line: the
 * account's SECOND machine registers as a drone (Tynn makes every desktop after the first one), and every way it had to
 * reach the owner's own host was refused here, before Tynn was asked: the workstation list, the Command Window's
 * "Connect to my workstations", the title bar's picker, the remote window, the tailnet dial. Made a pilot, the same
 * machine connected over the relay at once. Tynn decides who may connect (its entitlement: the owner, a share, a link);
 * the host decides whom it admits (relay-grant.ts principalOf). The caller's role decides nothing on the way out.
 */

const DRONE_SENTENCE = /is a drone/;

/** genie-host's device-link protocol over a fake link, in a machine Tynn calls a drone (the ports are cast once). */
function protocol(link: Partial<DeviceLinkProtocolPorts['link']>) {
    const ports = {
        link: { send: () => {}, close: () => {}, dropOwner: () => {}, browserVia: async () => ({ ok: false, reason: 'none' }), ...link },
        // What the old ports carried; a protocol that no longer reads them ignores them.
        role: { role: () => 'drone', said: () => 'drone', why: () => null, reread: vi.fn(async () => {}) },
        // The old port: re-worded every Tynn refusal from the role read again.
        wordTynnRefusal: async () => ({ ok: false as const, reason: 'This workstation is a drone: it cannot browse or open other workstations.' }),
        openBrowser: async () => null,
        remoteVia: () => {},
    } as unknown as DeviceLinkProtocolPorts;
    return deviceLinkProtocol(ports);
}

describe('a drone connects out like any machine', () => {
    it('the Command Window offers a drone its own workstations as well as a share link', () => {
        expect(connectPaletteActions('drone')).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
        // Control: a pilot and a signed-out Genie are offered the same.
        expect(connectPaletteActions('pilot')).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
        expect(connectPaletteActions(null)).toEqual([OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION]);
    });

    it('a drone dials another machine on the tailnet: the host opens the socket, nothing refuses it first', async () => {
        const open = vi.fn(async () => ({ ok: true as const, channel: 'device_1' }));
        const p = protocol({ open });
        expect(await p.call('window-1', 'open', ['wss://desk.tail1234.ts.net:7421/genie'])).toEqual({ ok: true, channel: 'device_1' });
        expect(open).toHaveBeenCalledWith('window-1', 'wss://desk.tail1234.ts.net:7421/genie');
        // Control: what is not another machine is still refused, in words.
        expect(await p.call('window-1', 'open', ['https://desk.example'])).toMatchObject({ ok: false });
    });

    it('a relay open Tynn refused is said in Tynn’s words, never re-worded as "a drone" from the role', async () => {
        const reason = 'Tynn did not give this machine a way in: sign in to Tynn, and check the workstation is shared with you';
        const p = protocol({ openRelay: async () => ({ ok: false as const, stage: 'tynn' as const, refusal: { ok: false as const, reason, refusedByTynn: true as const } }) });
        const opened = await p.call('window-1', 'openRelay', ['ws_desk']) as { ok: boolean; reason: string; stage?: string };
        expect(opened).toEqual({ ok: false, reason, stage: 'tynn' });
        expect(opened.reason).not.toMatch(DRONE_SENTENCE);
    });
});

/** A source with every comment line removed: a guard on code, not on a comment that mentions it. */
const code = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
    .join('\n');

describe('nothing on the way out is judged by the role', () => {
    it('main opens a remote window, a Take Over window and a window’s sockets without asking the role', () => {
        const main = code('src/main/main.ts');
        expect(main).toContain("ipcMain.handle('genie:remote-open-window'");
        expect(main).toContain("ipcMain.handle('genie:remote-takeover-open'");
        expect(main).not.toMatch(/outboundDialRefusal\(|droneRefusal\(|connectOutRefusal\(/);
    });

    it('genie-host lists the workstations for a drone (the list is Tynn’s to refuse) and says Tynn’s own refusal', () => {
        const hostApi = code('src/main/host-api.ts');
        const at = hostApi.indexOf("case 'tynnNetwork.workstations'");
        expect(at).toBeGreaterThan(-1);
        const listing = hostApi.slice(at, hostApi.indexOf('case ', at + 10));
        expect(listing).not.toMatch(/droneRefusal\(/);
        expect(listing).toContain('network.workstations()');
        expect(code('src/main/host-owner-ops.ts')).not.toMatch(/wordTynnRefusal\(/);
    });

    it('the window shows the connect picker and the list whatever the role', () => {
        expect(code('src/renderer/Shell.tsx')).not.toMatch(/mayBrowse\(/);
        expect(code('src/renderer/components/FeatureSurfaces.tsx')).not.toMatch(/mayBrowse\(/);
    });
});
