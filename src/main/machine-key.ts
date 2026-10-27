import { createHmac } from 'node:crypto';

/**
 * THIS MACHINE'S STABLE KEY FOR TYNN (genie#1278 W2; the owner, 2026-10-27: "just make sure pairing really knows the
 * device based on some machine id that never changes").
 *
 * The OS's own machine id — Windows `MachineGuid` (HKLM\SOFTWARE\Microsoft\Cryptography, set at OS install), Linux
 * `/etc/machine-id` (systemd, set at install), macOS `IOPlatformUUID` (the board) — survives reinstalling Genie,
 * updating it, wiping its data or the OS keychain, and Genie 1 beside Genie 2, because none of them own it.
 *
 * Tynn never sees the id: it is sent as HMAC-SHA256 under Genie's own salt (`machine_key`), and Tynn stores only an HMAC
 * of THAT under the owner's id. Same machine → same key → Tynn re-attaches the same record instead of a duplicate.
 * A cloned VM or disk image shares its machine id, so Tynn sees ONE machine; that clone never gets more than a drone
 * without the original's enrolled key (Tynn's re-attach rule). Give a clone its own id to make it its own machine.
 */

/** Genie's salt. Changing it changes every machine's key, so every machine would register afresh: never change it. */
export const MACHINE_KEY_SALT = 'genie.workstation.machine-key.v1';

/** Ids that do not name ONE machine: systemd's first-boot placeholder, all zeros, all ones. */
function namesOneMachine(hex: string): boolean {
    return /^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex) && !/^f+$/.test(hex);
}

/** The key Tynn is sent: HMAC-SHA256(salt, normalised id), 64 hex; null when the id names no single machine. */
export function machineKeyOf(rawId: string): string | null {
    const normalised = rawId.trim().replace(/^\{|\}$/g, '').toLowerCase();
    if (!namesOneMachine(normalised.replace(/-/g, ''))) return null;
    return createHmac('sha256', MACHINE_KEY_SALT).update(normalised).digest('hex');
}

export interface MachineIdPorts {
    readonly platform: string;
    readFile(path: string): Promise<string>;
    exec(command: string, args: readonly string[]): Promise<string>;
}

/** The OS machine id, as the OS prints it; null when it cannot be read. */
export async function readMachineId(ports: MachineIdPorts): Promise<string | null> {
    try {
        if (ports.platform === 'win32') {
            // The 64-bit view, so a 32-bit process would read the same value (WOW64 redirection).
            const out = await ports.exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
            return /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? null;
        }
        if (ports.platform === 'darwin') {
            const out = await ports.exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
            return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
        }
        if (ports.platform === 'linux') {
            for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                const id = await ports.readFile(path).then((t) => t.trim(), () => '');
                if (id !== '') return id;
            }
        }
        return null;
    } catch {
        return null;
    }
}
