import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeHostRuntime, runtimeFiles, type HostRuntimeInput } from '../src/main/host-runtime.js';

/**
 * THE HOST RUNS FROM A COPY (the host split, P6). A host on the install holds the binary, and an installer can't replace it:
 * measured on Electron 45.2.2, overwriting it is refused (EBUSY, ETXTBSY) under a host on it, and allowed beside a host on a
 * copy, which holds 0 files of the install. Keyed by Electron's version, so only an Electron update copies 240 MB.
 */

let root: string;
function write(file: string, text = 'x'): void { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }

function install(platform: NodeJS.Platform = 'linux'): HostRuntimeInput {
    const dist = join(root, 'install');
    const exe = join(dist, platform === 'win32' ? 'Genie.exe' : 'genie');
    write(exe, 'binary');
    for (const f of runtimeFiles(platform)) write(join(dist, f), f);
    write(join(dist, 'locales', 'en-US.pak'), 'not needed');
    const app = join(dist, 'resources', 'app');
    write(join(app, 'dist', 'main', 'host.js'), 'host');
    write(join(app, 'dist', 'main', 'chunk-1.js'), 'chunk');
    write(join(app, 'package.json'), '{"type":"module"}');
    write(join(app, 'node_modules', 'node-pty', 'index.js'), 'pty');
    write(join(app, 'node_modules', 'unrelated', 'index.js'), 'not needed');
    const unpacked = join(dist, 'resources', 'app.unpacked');
    write(join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'pty.node'), 'native');
    write(join(unpacked, 'node_modules', '@napi-rs', 'keyring', 'index.js'), 'keyring');
    write(join(unpacked, 'node_modules', '@napi-rs', 'keyring-linux-x64-gnu', 'k.node'), 'native');
    write(join(unpacked, 'node_modules', '@particle-academy', 'fancy-pty', 'bin', 'helper'), 'helper');
    return { packaged: true, platform, execPath: exe, electronVersion: '45.2.2', appRoot: app, unpackedRoot: unpacked, hostHash: 'abc123', genieHome: join(root, 'home'), log: () => {} };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'host-runtime-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('runtimeFiles: what Electron needs beside its binary (measured)', () => {
    it('both systems', () => {
        for (const platform of ['linux', 'win32'] as const) {
            expect(runtimeFiles(platform)).toEqual(expect.arrayContaining(['icudtl.dat', 'v8_context_snapshot.bin']));
        }
    });
    it('Linux links libffmpeg; Windows ran without ffmpeg.dll', () => {
        expect(runtimeFiles('linux')).toContain('libffmpeg.so');
        expect(runtimeFiles('win32')).not.toContain('ffmpeg.dll');
    });
});

describe('the copy', () => {
    it('answers paths under Genie’s home, none under the install', async () => {
        const input = install();
        const got = await materializeHostRuntime(input);
        expect(got.error).toBeNull();
        expect(got.execPath).toBe(join(input.genieHome, 'host', 'runtime-45.2.2', 'genie'));
        expect(got.hostScript).toBe(join(input.genieHome, 'host', 'abc123', 'dist', 'main', 'host.js'));
        expect(read(got.execPath, 'utf8')).toBe('binary');
        expect(read(got.hostScript, 'utf8')).toBe('host');
    });

    it('holds what the host needs: its chunks, its package marker, and its native packages from the unpacked side', async () => {
        const input = install();
        const got = await materializeHostRuntime(input);
        const app = join(input.genieHome, 'host', 'abc123');
        for (const f of ['dist/main/chunk-1.js', 'package.json', 'node_modules/node-pty/index.js', 'node_modules/node-pty/prebuilds/pty.node', 'node_modules/@napi-rs/keyring/index.js', 'node_modules/@napi-rs/keyring-linux-x64-gnu/k.node', 'node_modules/@particle-academy/fancy-pty/bin/helper']) {
            expect(existsSync(join(app, f)), f).toBe(true);
        }
        expect(got.error).toBeNull();
    });

    it('not what it doesn’t', async () => {
        const input = install();
        await materializeHostRuntime(input);
        expect(existsSync(join(input.genieHome, 'host', 'abc123', 'node_modules', 'unrelated'))).toBe(false);
        expect(existsSync(join(input.genieHome, 'host', 'runtime-45.2.2', 'locales'))).toBe(false);
    });

    it('Linux: the binary and the helper can run', async () => {
        if (process.platform === 'win32') return;
        const input = install();
        const got = await materializeHostRuntime(input);
        expect(statSync(got.execPath).mode & 0o111).toBe(0o111);
        expect(statSync(join(input.genieHome, 'host', 'abc123', 'node_modules', '@particle-academy', 'fancy-pty', 'bin', 'helper')).mode & 0o111).toBe(0o111);
    });
});

describe('the second launch', () => {
    it('copies nothing: the same files, untouched', async () => {
        const input = install();
        const first = await materializeHostRuntime(input);
        expect(first.copied).toBe(true);
        write(first.execPath, 'in use');
        const second = await materializeHostRuntime(input);
        expect(second.copied).toBe(false);
        expect(read(second.execPath, 'utf8')).toBe('in use');
    });

    it('a new host, same Electron: the runtime is kept, only the app is copied', async () => {
        const input = install();
        const first = await materializeHostRuntime(input);
        write(first.execPath, 'in use');
        const next = await materializeHostRuntime({ ...input, hostHash: 'def456' });
        expect(read(next.execPath, 'utf8')).toBe('in use');
        expect(next.hostScript).toContain('def456');
    });

    it('a new Electron: a new runtime folder, the old one left for what still runs on it', async () => {
        const input = install();
        const first = await materializeHostRuntime(input);
        const next = await materializeHostRuntime({ ...input, electronVersion: '46.0.0' });
        expect(next.execPath).toContain('runtime-46.0.0');
        expect(existsSync(first.execPath)).toBe(true);
    });
});

describe('a torn copy', () => {
    it('with no marker is never run: copied again', async () => {
        const input = install();
        const first = await materializeHostRuntime(input);
        rmSync(join(input.genieHome, 'host', 'runtime-45.2.2', '.complete'));
        write(first.execPath, 'torn');
        const second = await materializeHostRuntime(input);
        expect(read(second.execPath, 'utf8')).toBe('binary');
    });

    it('the marker is written last', async () => {
        const input = install();
        const order: string[] = [];
        await materializeHostRuntime({ ...input, onWrite: (file) => order.push(file) });
        const runtime = order.filter((f) => f.includes('runtime-45.2.2'));
        expect(runtime.at(-1)).toMatch(/\.complete$/);
        const app = order.filter((f) => f.includes('abc123'));
        expect(app.at(-1)).toMatch(/\.complete$/);
    });
});

describe('a copy that can’t be made', () => {
    it('answers the install, with the reason: Genie still starts, and goes down at the next update, as before', async () => {
        const input = install();
        write(join(input.genieHome, 'host'), 'a file where the folder goes');
        const log = vi.fn();
        const got = await materializeHostRuntime({ ...input, log });
        expect(got.execPath).toBe(input.execPath);
        expect(got.hostScript).toBe(join(input.appRoot, 'dist', 'main', 'host.js'));
        expect(got.error).toMatch(/copy/);
        expect(log).toHaveBeenCalled();
    });

    it('a file it needs that isn’t there is that too, not half a runtime', async () => {
        const input = install();
        rmSync(join(dirname(input.execPath), 'icudtl.dat'));
        const got = await materializeHostRuntime(input);
        expect(got.execPath).toBe(input.execPath);
        expect(got.error).toMatch(/icudtl/);
    });
});

describe('old copies', () => {
    it('an older host’s app folder goes when nothing holds it; the current one stays', async () => {
        const input = install();
        const first = await materializeHostRuntime(input);
        const next = await materializeHostRuntime({ ...input, hostHash: 'def456' });
        expect(existsSync(first.hostScript)).toBe(false);
        expect(existsSync(next.hostScript)).toBe(true);
        expect(readdirSync(join(input.genieHome, 'host')).sort()).toEqual(['def456', 'runtime-45.2.2']);
    });
});

describe('a development run', () => {
    it('runs from the tree, and copies nothing', async () => {
        const input = install();
        const got = await materializeHostRuntime({ ...input, packaged: false });
        expect(got.execPath).toBe(input.execPath);
        expect(got.copied).toBe(false);
        expect(existsSync(join(input.genieHome, 'host'))).toBe(false);
    });
});

describe('the wire', () => {
    it('the window starts the host from the copy, and awaits it before linking', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/await materializeHostRuntime\(/);
        expect(main).toMatch(/hostScript: hostRuntime\.hostScript/);
        expect(main).toMatch(/execPath: hostRuntime\.execPath/);
    });
});
