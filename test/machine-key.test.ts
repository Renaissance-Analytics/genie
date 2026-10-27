import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MACHINE_KEY_SALT, machineKeyOf, readMachineId } from '../src/main/machine-key.js';

/**
 * ONE MACHINE, ONE TYNN WORKSTATION (genie#1278 W2; the owner, 2026-10-27: "just make sure pairing really knows the
 * device based on some machine id that never changes"). The OS's own machine id — Windows `MachineGuid`, Linux
 * `/etc/machine-id`, macOS `IOPlatformUUID` — survives reinstalling Genie, updating it, wiping its data or keychain, and
 * Genie 1 beside Genie 2. Genie never sends it raw: Tynn gets an HMAC of it under Genie's own salt.
 */

const GUID = '4C4C4544-0035-4E10-8058-B4C04F4A3333';

describe('machineKeyOf — what Tynn is sent', () => {
    it('is HMAC-SHA256 of the normalised id under Genie\'s salt: 64 hex, never the id itself', () => {
        const key = machineKeyOf(GUID)!;
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).toBe(createHmac('sha256', MACHINE_KEY_SALT).update(GUID.toLowerCase()).digest('hex'));
        expect(key).not.toContain(GUID.toLowerCase().replace(/-/g, '').slice(0, 8));
    });

    it('is the same however the OS prints the id (case, braces, whitespace), and differs per machine', () => {
        expect(machineKeyOf(`  {${GUID.toLowerCase()}}\n`)).toBe(machineKeyOf(GUID));
        expect(machineKeyOf('0123456789abcdef0123456789abcdef')).not.toBe(machineKeyOf(GUID));
    });

    it('refuses ids that do not name ONE machine (empty, uninitialised, all zeros)', () => {
        for (const id of ['', '   ', 'uninitialized', '00000000000000000000000000000000', '00000000-0000-0000-0000-000000000000', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', 'not-a-machine-id']) {
            expect(machineKeyOf(id)).toBeNull();
        }
    });
});

describe('readMachineId — the OS machine id, per platform', () => {
    const none = async () => { throw new Error('ENOENT'); };

    it('Windows: MachineGuid from the 64-bit registry view', async () => {
        const calls: string[][] = [];
        const id = await readMachineId({
            platform: 'win32',
            readFile: none,
            exec: async (cmd, args) => { calls.push([cmd, ...args]); return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${GUID}\r\n\r\n`; },
        });
        expect(id).toBe(GUID);
        expect(calls).toEqual([['reg', 'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']]);
    });

    it('Linux: /etc/machine-id, else the D-Bus copy', async () => {
        const files: Record<string, string> = { '/var/lib/dbus/machine-id': '0123456789abcdef0123456789abcdef\n' };
        const read = async (p: string) => { if (p in files) return files[p]!; throw new Error('ENOENT'); };
        expect(await readMachineId({ platform: 'linux', readFile: read, exec: none })).toBe('0123456789abcdef0123456789abcdef');
        files['/etc/machine-id'] = 'fedcba9876543210fedcba9876543210\n';
        expect(await readMachineId({ platform: 'linux', readFile: read, exec: none })).toBe('fedcba9876543210fedcba9876543210');
    });

    it('macOS: IOPlatformUUID', async () => {
        const id = await readMachineId({ platform: 'darwin', readFile: none, exec: async () => `+-o Mac  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "${GUID}"\n` });
        expect(id).toBe(GUID);
    });

    it('nothing readable: no id (Genie then registers without one, as before)', async () => {
        expect(await readMachineId({ platform: 'win32', readFile: none, exec: async () => 'ERROR: The system was unable to find the specified registry key' })).toBeNull();
        expect(await readMachineId({ platform: 'linux', readFile: none, exec: none })).toBeNull();
        expect(await readMachineId({ platform: 'freebsd', readFile: none, exec: none })).toBeNull();
    });
});
