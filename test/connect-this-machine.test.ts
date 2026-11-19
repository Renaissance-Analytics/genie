import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connectableWorkstations } from '../src/main/tynn-network.js';

/**
 * THE MACHINE YOU ARE ON IS NEVER IN "YOUR WORKSTATIONS" (the owner, 2026-10-28, on beta.50: "it shouldn't show the
 * machine I am currently on").
 *
 * Measured on the owner's desktop (AlphaR): it holds TWO Tynn identities. Genie 1 registered it as
 * `01kxw523…` (`settings.workstation_id` in Genie 1's genie.db, under the userData Genie 2 shares); Genie 2 registered
 * it again as `01m5epvk…` (`~/.genie/workstation.json`). Genie 1 never sent a machine key, so Tynn cannot tell the two
 * are one machine, and Tynn's `connectable` does not leave the caller out (WorkstationController::connectable). Genie 2
 * left out one id, and only once this launch's registration had finished (`tynnWorkstationNow.registered`) — so the
 * Genie 1 record was always listed, and before (or without) a finished registration so was Genie 2's own.
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ROWS = [
    { id: 'ws_v2_self', name: 'AlphaR', status: 'active', is_local: true, connectable: true, source: 'owner', registered_by_you: true, role: 'pilot' },
    { id: 'ws_v1_self', name: 'AlphaR', status: 'active', is_local: true, connectable: true, source: 'owner', registered_by_you: true, role: 'pilot' },
    { id: 'ws_other', name: 'Foundation', status: 'active', is_local: true, connectable: true, source: 'owner', registered_by_you: true, role: 'drone' },
];

describe('every Tynn identity this machine holds is left out', () => {
    it('Genie 2’s own record AND the Genie 1-era record of the same machine', async () => {
        const list = await connectableWorkstations(async () => json(200, { workstations: ROWS }), new Set(['ws_v2_self', 'ws_v1_self']));
        expect(list.ok && list.workstations.map((w) => w.id)).toEqual(['ws_other']);
    });

    it('CONTROL: another machine with the same NAME is still listed (identity, not name, decides)', async () => {
        const rows = [...ROWS, { id: 'ws_namesake', name: 'AlphaR', status: 'active', is_local: true, connectable: true, source: 'owner', registered_by_you: true, role: 'drone' }];
        const list = await connectableWorkstations(async () => json(200, { workstations: rows }), new Set(['ws_v2_self', 'ws_v1_self']));
        expect(list.ok && list.workstations.map((w) => w.id)).toEqual(['ws_other', 'ws_namesake']);
    });
});

/*
 * "Your workstations" is answered by genie-host's owner operations for every client (Tynn #898 steps 2d-3b and 2d-4b2):
 * host-owner-ops.ts lists, and genie-host.ts gives it the stored identity and Genie 1's settings.
 */
describe('wired: genie-host asks with every identity this machine holds, not the one this launch registered', () => {
    const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const ops = strip(readFileSync(new URL('../src/main/host-owner-ops.ts', import.meta.url), 'utf8'));
    const host = strip(readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8'));
    const handler = /workstations: async \(\) => \{([^]*?)\n {12}\},/.exec(ops)?.[1] ?? '';

    it('the list handler takes this machine’s ids from thisMachine, never from the registration result alone', () => {
        expect(handler).toContain('connectableWorkstations(');
        expect(handler).toMatch(/await thisMachine\(a\.host\(\)\)/);
        expect(handler).not.toContain('tynn.registered()');
    });

    it('thisMachine reads the stored Genie 2 identity and Genie 1’s workstation_id', () => {
        const wiring = /const thisMachine = async[^]*?;\n/.exec(ops)?.[0] ?? '';
        expect(wiring).toContain('tynn.registered()');
        expect(wiring).toContain('await tynn.stored(host)');
        expect(wiring).toContain('tynn.v1Settings()');
        expect(host).toMatch(/stored: async \(host\) => \(await workstationService\.identity\(host\)\)\?\.workstationId \?\? null,/);
        expect(host).toMatch(/v1Settings: \(\) => \(v1DatabasePath \? readV1Settings\(v1DatabasePath\) : null\),/);
    });
});
