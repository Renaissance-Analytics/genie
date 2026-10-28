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
    { id: 'ws_v2_self', name: 'AlphaR', status: 'active', is_local: true, connectable: true, source: 'owner', role: 'pilot' },
    { id: 'ws_v1_self', name: 'AlphaR', status: 'active', is_local: true, connectable: true, source: 'owner', role: 'pilot' },
    { id: 'ws_other', name: 'Foundation', status: 'active', is_local: true, connectable: true, source: 'owner', role: 'drone' },
];

describe('every Tynn identity this machine holds is left out', () => {
    it('Genie 2’s own record AND the Genie 1-era record of the same machine', async () => {
        const list = await connectableWorkstations(async () => json(200, { workstations: ROWS }), new Set(['ws_v2_self', 'ws_v1_self']));
        expect(list.ok && list.workstations.map((w) => w.id)).toEqual(['ws_other']);
    });

    it('CONTROL: another machine with the same NAME is still listed (identity, not name, decides)', async () => {
        const rows = [...ROWS, { id: 'ws_namesake', name: 'AlphaR', status: 'active', is_local: true, connectable: true, source: 'owner', role: 'drone' }];
        const list = await connectableWorkstations(async () => json(200, { workstations: rows }), new Set(['ws_v2_self', 'ws_v1_self']));
        expect(list.ok && list.workstations.map((w) => w.id)).toEqual(['ws_other', 'ws_namesake']);
    });
});

describe('wired: main asks with every identity it holds, not the one this launch registered', () => {
    const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
    const handler = /ipcMain\.handle\('genie:tynn-workstations'([^]*?)\n {4}\}\);/.exec(main)?.[1] ?? '';

    it('the list handler takes this machine’s ids from thisMachineIds, never from the registration result alone', () => {
        expect(handler).toContain('connectableWorkstations(');
        expect(handler).toMatch(/await thisMachineIds\(\)/);
        expect(handler).not.toContain('tynnWorkstationNow?.registered ? tynnWorkstationNow.workstationId');
    });

    it('thisMachineIds reads the stored Genie 2 identity and Genie 1’s workstation_id', () => {
        const wiring = /thisMachineIds = \(\)[^]*?;\n/.exec(main)?.[0] ?? '';
        expect(wiring).toContain('identities.read(');
        expect(wiring).toContain('readV1Settings(v1DatabaseFile())');
    });
});
