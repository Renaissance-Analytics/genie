import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../../test/electron-mock';

/**
 * The update-survival + reboot-survival machinery for the pty-host on
 * locked-down machines:
 *
 *   - materializeRuntimeToUserData copies the shipped standalone runtime into a
 *     VERSIONED per-user dir OUTSIDE the install dir, so the auto-updater
 *     replacing the app never disturbs the running host (the bug: every update
 *     restarted live agent terminals despite the standalone teardown).
 *   - the HKCU Run-key helpers register a logon relaunch on machines where the
 *     scheduled-task service is policy-blocked (schtasks → "Access is denied").
 */

vi.mock('@particle-academy/fancy-term-host', () => ({
    HostClient: class {},
    isHostBacked: () => false,
    ptyHostScriptPath: () => null,
    setActiveBackend: () => {},
    socketPathFor: (d: string) => path.join(d, 'sock'),
}));
vi.mock('@particle-academy/fancy-term-host/service', () => ({
    buildServiceDescriptor: () => ({
        platform: 'windows-task',
        unitPath: '',
        unitContents: '',
        installArgv: [],
        uninstallArgv: [],
        startArgv: [],
        statusArgv: [],
    }),
    ensureHostService: async () => ({ ok: false }),
    resolveServiceConfig: (c: unknown) => c,
    resolveServiceRuntime: () => null,
}));

import {
    runtimeKeyFor,
    materializeRuntimeToUserData,
    runKeyVbsContents,
    runKeyRegAddArgv,
    isServiceBlocked,
    HOST_SERVICE_LABEL,
} from '../host-service';

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-runtime-'));
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** A fake shipped runtime dir: node binary + node-pty + optional version.txt. */
function makeShipped(version?: string): string {
    const root = path.join(tmp, 'shipped');
    fs.mkdirSync(path.join(root, 'node-pty'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node.exe'), 'FAKE-NODE-BINARY');
    fs.writeFileSync(path.join(root, 'node-pty', 'index.js'), 'module.exports={}');
    if (version) fs.writeFileSync(path.join(root, 'version.txt'), `${version}\n`);
    return root;
}

describe('runtimeKeyFor — the versioned copy key', () => {
    it('uses the shipped version marker, trimmed', () => {
        expect(runtimeKeyFor('20.20.2-win32-x64\n', 123)).toBe('20.20.2-win32-x64');
    });

    it('falls back to the node binary size for pre-marker builds', () => {
        expect(runtimeKeyFor(null, 456)).toBe('sz456');
        expect(runtimeKeyFor('   ', 789)).toBe('sz789');
    });

    it('sanitises unsafe characters to a valid dir name', () => {
        expect(runtimeKeyFor('20.20.2 win32/x64', 1)).toBe('20.20.2_win32_x64');
    });
});

describe('materializeRuntimeToUserData — the update-survival copy', () => {
    it('copies the shipped runtime into a versioned dir with a completion marker', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');

        const dest = materializeRuntimeToUserData(shipped, 'node.exe', base);

        expect(dest).toBe(path.join(base, '20.20.2-win32-x64'));
        expect(fs.existsSync(path.join(dest!, 'node.exe'))).toBe(true);
        expect(fs.existsSync(path.join(dest!, 'node-pty', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(dest!, '.complete'))).toBe(true);
    });

    it('REUSES an existing complete copy untouched — the running host is never disturbed', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        const first = materializeRuntimeToUserData(shipped, 'node.exe', base)!;

        // Canary: a change inside the user-data copy must SURVIVE the next call
        // (same key ⇒ no re-copy — that's what keeps a live host's files stable).
        fs.writeFileSync(path.join(first, 'canary.txt'), 'still here');

        const second = materializeRuntimeToUserData(shipped, 'node.exe', base);
        expect(second).toBe(first);
        expect(fs.readFileSync(path.join(first, 'canary.txt'), 'utf8')).toBe('still here');
    });

    it('a NEW runtime version lands in a NEW dir and the old copy is kept for the old host', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        const oldDir = materializeRuntimeToUserData(shipped, 'node.exe', base)!;

        fs.writeFileSync(path.join(shipped, 'version.txt'), '22.1.0-win32-x64\n');
        const newDir = materializeRuntimeToUserData(shipped, 'node.exe', base)!;

        expect(newDir).toBe(path.join(base, '22.1.0-win32-x64'));
        expect(newDir).not.toBe(oldDir);
        // The superseded copy survives — an old host may still be running it.
        expect(fs.existsSync(path.join(oldDir, 'node.exe'))).toBe(true);
    });

    it('prunes crashed .staging-* leftovers and recovers a torn copy', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        // A torn previous attempt: dest exists but has no .complete marker.
        const dest = path.join(base, '20.20.2-win32-x64');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'garbage'), 'torn');
        // And a crashed staging dir from a dead pid.
        fs.mkdirSync(path.join(base, '20.20.2-win32-x64.staging-99999'), { recursive: true });

        const out = materializeRuntimeToUserData(shipped, 'node.exe', base);

        expect(out).toBe(dest);
        expect(fs.existsSync(path.join(dest, '.complete'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'node.exe'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'garbage'))).toBe(false); // torn attempt replaced
        expect(fs.existsSync(path.join(base, '20.20.2-win32-x64.staging-99999'))).toBe(false);
    });

    it('returns null when the shipped node binary is missing (caller falls back in place)', () => {
        const root = path.join(tmp, 'empty');
        fs.mkdirSync(root, { recursive: true });
        expect(materializeRuntimeToUserData(root, 'node.exe', path.join(tmp, 'b'))).toBeNull();
    });
});

describe('Run-key autostart helpers (policy-blocked schtasks fallback)', () => {
    it('builds a windowless wscript launcher with VBS-doubled quotes', () => {
        expect(runKeyVbsContents('C:\\Users\\g\\unit.cmd')).toBe(
            'CreateObject("WScript.Shell").Run """C:\\Users\\g\\unit.cmd""", 0, False\r\n',
        );
    });

    it('builds the reg add argv for the per-user Run key', () => {
        expect(runKeyRegAddArgv('C:\\ud\\launcher.vbs')).toEqual([
            'reg',
            'add',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v',
            HOST_SERVICE_LABEL,
            '/t',
            'REG_SZ',
            '/d',
            'wscript.exe "C:\\ud\\launcher.vbs"',
            '/f',
        ]);
    });

    it('isServiceBlocked reflects the persisted denial marker', () => {
        expect(isServiceBlocked(tmp)).toBe(false);
        fs.writeFileSync(path.join(tmp, 'ptyhost-service-blocked'), 'denied');
        expect(isServiceBlocked(tmp)).toBe(true);
    });
});
