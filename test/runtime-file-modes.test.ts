import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppInboxKeys } from '../src/main/app-inbox-keys.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { ServiceDriver } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';
import { writeJsonAtomic } from '../src/main/store.js';
import { TerminalSnapshots } from '../src/main/terminal-snapshots.js';

/**
 * PLAINTEXT FILES THAT HOLD SECRETS ARE THE OWNER'S ALONE (host-split plan §13). `services.json` holds every engine's
 * passwords and `terminal-snapshots.json` a terminal's scrollback, in the clear, and both were written with the default mode:
 * 0644 under a usual umask, readable by any user of the machine. `remote-devices.json` and `app-inbox.json` hold hashes, and
 * are kept the same way. A fresh write is 0600, and a file an older Genie left at 0644 is tightened at open — it may not be
 * rewritten for a long time. POSIX modes: on Windows the profile's ACL is the guard, and these are no-ops.
 *
 * An engine's config file stays 0644 on purpose: the engine's container reads it (service-registry.ts diskConfigFiles).
 */

const modeOf = (file: string) => statSync(file).mode & 0o777;
let home: string;
let runtime: string;
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'runtime-modes-'));
    runtime = join(home, 'runtime');
    mkdirSync(runtime, { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

/** A file an older Genie left: world-readable, whatever this process's umask would have made it. */
function leftOpen(file: string, text: string): void {
    writeFileSync(file, text);
    chmodSync(file, 0o644);
    expect(modeOf(file)).toBe(0o644); // CONTROL: the gauge can read an open file
}

describe.skipIf(process.platform === 'win32')('runtime files that hold secrets', () => {
    it('CONTROL: writeJsonAtomic with no mode leaves the file as open as the umask allows; with a mode it is that mode', async () => {
        const open = join(home, 'open.json');
        await writeJsonAtomic(open, { a: 1 });
        expect(modeOf(open)).toBe(0o666 & ~process.umask());
        const closed = join(home, 'closed.json');
        await writeJsonAtomic(closed, { a: 1 }, { mode: 0o600 });
        expect(modeOf(closed)).toBe(0o600);
    });

    it('services.json (the engines’ passwords): tightened at open, its contents untouched', async () => {
        const file = join(runtime, 'services.json');
        leftOpen(file, '{"instances":[]}');
        await ServiceRegistry.open(home, new ServiceDriver(async () => ({ stdout: '', exitCode: 0 })), { allocatePort: () => 4101, randomPassword: () => 'pw' });
        expect(modeOf(file)).toBe(0o600);
        expect(readFileSync(file, 'utf8')).toBe('{"instances":[]}');
    });

    it('services.json: every flush keeps it 0600', () => {
        const code = readFileSync('src/main/service-registry.ts', 'utf8');
        expect(code).toMatch(/await writeJsonAtomic\(this\.#file, this\.#data, PRIVATE_FILE\);/);
    });

    it('remote-devices.json: tightened at open; a fresh write is 0600', async () => {
        const file = join(runtime, 'remote-devices.json');
        leftOpen(file, '{"devices":[]}');
        await DeviceStore.open(home, { now: () => 1, random: () => 'tok' });
        expect(modeOf(file)).toBe(0o600);

        const fresh = await mkdtemp(join(tmpdir(), 'runtime-modes-fresh-'));
        const devices = await DeviceStore.open(fresh, { now: () => 1, random: () => 'tok' });
        devices.pair('phone');
        await devices.flushed();
        expect(modeOf(join(fresh, 'runtime', 'remote-devices.json'))).toBe(0o600);
        await rm(fresh, { recursive: true, force: true });
    });

    it('app-inbox.json: tightened at open; a fresh write is 0600', async () => {
        const file = join(runtime, 'app-inbox.json');
        leftOpen(file, '{"scriptKeys":[],"revoked":[]}');
        await AppInboxKeys.open(home);
        expect(modeOf(file)).toBe(0o600);

        const fresh = await mkdtemp(join(tmpdir(), 'runtime-modes-fresh-'));
        const keys = await AppInboxKeys.open(fresh);
        await keys.createScriptKey('ws', 'a script');
        expect(modeOf(join(fresh, 'runtime', 'app-inbox.json'))).toBe(0o600);
        await rm(fresh, { recursive: true, force: true });
    });

    it('terminal-snapshots.json (scrollback): tightened at open; a fresh save is 0600', async () => {
        const file = join(home, 'terminal-snapshots.json');
        leftOpen(file, '{"ws":"old scrollback"}');
        const opened = await TerminalSnapshots.open(home);
        expect(modeOf(file)).toBe(0o600);
        expect(opened.take('ws')).toBe('old scrollback');
        await opened.flushed();

        const fresh = await mkdtemp(join(tmpdir(), 'runtime-modes-fresh-'));
        const snapshots = await TerminalSnapshots.open(fresh);
        await snapshots.save([{ workspaceId: 'ws', scrollback: 'a token in a buffer' }]);
        expect(modeOf(join(fresh, 'terminal-snapshots.json'))).toBe(0o600);
        await rm(fresh, { recursive: true, force: true });
    });
});
