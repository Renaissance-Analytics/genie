import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { droneRefusal, effectiveRoleOf, mayBrowse, parseMeRole } from '../src/core/workstation-role.js';
import { readWorkstationRole } from '../src/main/workstation-role-reader.js';
import { workstationKeyStore } from '../src/main/workstation-identity.js';

/**
 * PILOT / DRONE ON THIS GENIE (genie#1278 W5; the owner, 2026-10-27): "no agent running on a workstation should ever be
 * able to change this setting by hacking the db or flipping a bool in a config file". The role lives in Tynn; Genie
 * reads it from `GET /api/v1/workstations/me` and from nowhere else. Signed in to Tynn, anything but a plain "pilot"
 * from Tynn is a drone — an unreadable answer, an unbound pairing, a network error. Signed out, this Genie is not on the
 * Tynn network at all, and there is nothing of the network to browse.
 */

const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('what Tynn says this workstation is', () => {
    it('reads exactly "pilot" or "drone"; anything else is no answer', () => {
        expect(parseMeRole({ role: 'pilot', workstation: { id: 'w', role: 'pilot' } })).toBe('pilot');
        expect(parseMeRole({ role: 'drone' })).toBe('drone');
        for (const body of [{ role: 'PILOT' }, { role: ' pilot' }, { role: true }, { role: null }, { workstation: { role: 'pilot' } }, null, 'pilot', []]) {
            expect(parseMeRole(body)).toBeNull();
        }
    });

    it('signed in: only a pilot answer is a pilot; no answer is a drone (fail closed)', () => {
        expect(effectiveRoleOf({ signedIn: true, role: 'pilot' })).toBe('pilot');
        expect(effectiveRoleOf({ signedIn: true, role: 'drone' })).toBe('drone');
        expect(effectiveRoleOf({ signedIn: true, role: null })).toBe('drone');
        expect(effectiveRoleOf({ signedIn: false })).toBeNull();
    });

    it('a drone may not browse; a pilot may; a Genie not on the Tynn network has no Tynn role to restrict', () => {
        expect(mayBrowse('drone')).toBe(false);
        expect(mayBrowse('pilot')).toBe(true);
        expect(mayBrowse(null)).toBe(true);
        expect(droneRefusal('drone')).toMatch(/drone/);
        expect(droneRefusal('pilot')).toBeNull();
        expect(droneRefusal(null)).toBeNull();
    });
});

describe('readWorkstationRole — GET /api/v1/workstations/me, nothing else', () => {
    let dir: string | null = null;
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

    it('asks Tynn and returns its answer', async () => {
        const calls: string[] = [];
        const role = await readWorkstationRole(async (path, init) => { calls.push(`${init.method} ${path}`); return respond(200, { role: 'pilot' }); });
        expect(role).toBe('pilot');
        expect(calls).toEqual(['GET /api/v1/workstations/me']);
    });

    it('Tynn refuses, errors or cannot be reached: no answer (which a signed-in Genie treats as a drone)', async () => {
        expect(await readWorkstationRole(async () => respond(404, null))).toBeNull();
        expect(await readWorkstationRole(async () => respond(500, { role: 'pilot' }))).toBeNull();
        expect(await readWorkstationRole(async () => { throw new Error('offline'); })).toBeNull();
    });

    it('a role written into the local identity file or settings changes nothing: Tynn says drone, it is a drone', async () => {
        dir = mkdtempSync(join(tmpdir(), 'genie-role-'));
        const file = join(dir, 'workstation.json');
        // What an agent on a drone could write: a role, a pilot flag, in the identity file Genie keeps.
        writeFileSync(file, JSON.stringify({ 'https://tynn.example.com': { workstationId: 'ws_1', keyEnc: 'x', role: 'pilot', pilot: true } }));
        const store = workstationKeyStore(file, { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() });
        await store.read('https://tynn.example.com');
        const settings = { workstation_role: 'pilot', role: 'pilot', pilot: true };

        const role = await readWorkstationRole(async () => respond(200, { role: 'drone' }));
        expect(effectiveRoleOf({ signedIn: true, role })).toBe('drone');
        expect(mayBrowse(effectiveRoleOf({ signedIn: true, role }))).toBe(false);
        // And with Tynn unreachable, the local values still grant nothing.
        const offline = await readWorkstationRole(async () => { throw new Error('offline'); });
        expect(mayBrowse(effectiveRoleOf({ signedIn: true, role: offline }))).toBe(false);
        expect(settings.role).toBe('pilot'); // (the local values were there all along)
    });
});
