import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ENTRY_OPTIONS, KEYCHAIN_SERVICE, Keychain, type KeyringModule } from '../src/main/keychain.js';
import { openHostKeychain } from '../src/main/host-keychain.js';

/**
 * THE KEYCHAIN (the host split, P3.4 cut a; plan §13). Secrets go to the OS keychain through @napi-rs/keyring, in genie-host.
 *
 * THE PIN IS THE CORE. On Linux an unpinned entry falls back to the kernel keyutils store when no Secret Service runs, and
 * that store "will not persist across reboots": a write and its read-back would both succeed, and the secret would be gone
 * at the next reboot. Every entry is pinned to `secret-service`, so no Secret Service is a FAILURE, never a quiet fallback.
 *
 * "Missing" and "unavailable" are different answers: a locked keychain must never read as signed out. With no keychain a
 * secret is REFUSED (decision 3): nothing here can write anywhere else. The module's fakes hold what is asserted;
 * scripts/perf-lag/keychain-measure.mjs measures the real library on the VMs.
 */

function fakeModule(store = new Map<string, string>(), failWith: Error | null | (() => Error | null) = null) {
    const failure = () => (typeof failWith === 'function' ? failWith() : failWith);
    const made: Array<{ service: string; username: string; options: unknown }> = [];
    class AsyncEntry {
        readonly #key: string;
        constructor(service: string, username: string, options?: unknown) {
            made.push({ service, username, options });
            this.#key = `${service}/${username}`;
        }
        async getPassword(): Promise<string | null> { const e = failure(); if (e) throw e; return store.get(this.#key) ?? null; }
        async setPassword(value: string): Promise<void> { const e = failure(); if (e) throw e; store.set(this.#key, value); }
        async deletePassword(): Promise<boolean> { const e = failure(); if (e) throw e; return store.delete(this.#key); }
    }
    return { module: { AsyncEntry } as unknown as KeyringModule, made, store };
}

describe('with nothing on the bus, the library throws from its constructor', () => {
    // The real words, omarchy-test, batch V: the service not running and its activation file gone.
    const NOT_ACTIVATABLE = 'Platform failure: DBus error: The name is not activatable';
    const refusing = {
        AsyncEntry: class { constructor() { throw new Error(NOT_ACTIVATABLE); } },
    } as unknown as KeyringModule;

    it('a read is unavailable, in those words: not missing, which would read as signed out, and not a throw', async () => {
        const k = new Keychain(async () => refusing);
        expect(await k.get('tynn/pairing')).toEqual({ kind: 'unavailable', reason: expect.stringContaining(NOT_ACTIVATABLE) });
    });

    it('a write, a delete and the probe all refuse, and none of them throws', async () => {
        const k = new Keychain(async () => refusing);
        expect((await k.set('tynn/pairing', 'v')).ok).toBe(false);
        expect((await k.delete('tynn/pairing')).ok).toBe(false);
        expect((await k.probe()).ok).toBe(false);
    });

    it('the same words from the read itself are the same answer', async () => {
        const k = new Keychain(async () => fakeModule(new Map(), new Error(NOT_ACTIVATABLE)).module);
        expect((await k.get('tynn/pairing')).kind).toBe('unavailable');
    });
});

describe('every entry is pinned to the Secret Service', () => {
    it('the options say secret-service, the one value that cannot fall back to the kernel keyring', () => {
        expect(ENTRY_OPTIONS).toEqual({ linux: { store: 'secret-service' } });
    });

    it('get, set, delete and the probe each build their entry with the pin, under Genie’s service name', async () => {
        const f = fakeModule();
        const k = new Keychain(async () => f.module);
        await k.get('tynn/pairing');
        await k.set('tynn/pairing', 'v');
        await k.delete('tynn/pairing');
        await k.probe();
        expect(f.made.length).toBeGreaterThanOrEqual(4);
        for (const m of f.made) {
            expect(m.service).toBe(KEYCHAIN_SERVICE);
            expect(m.options).toEqual({ linux: { store: 'secret-service' } });
        }
    });

    /** GUARD: every entry anywhere in src/, in any form, is built in keychain.ts, with the pin. */
    it('nothing in src/ builds an entry anywhere else, or without the pin', () => {
        const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
        const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        const built = files('src').flatMap((f) => (strip(readFileSync(f, 'utf8')).match(/new\s+(?:Async)?Entry\s*\([^)]*\)|(?:Async)?Entry\s*\.\s*withTarget\s*\([^)]*\)/g) ?? []).map((call) => ({ file: f.split('\\').join('/'), call })));
        expect(built).toEqual([{ file: 'src/main/keychain.ts', call: 'new AsyncEntry(KEYCHAIN_SERVICE, name, ENTRY_OPTIONS)' }]);
        // The library itself is imported in that one file only.
        const importing = files('src').filter((f) => /['"]@napi-rs\/keyring['"]/.test(strip(readFileSync(f, 'utf8')))).map((f) => f.split('\\').join('/'));
        expect(importing).toEqual(['src/main/keychain.ts']);
    });
});

describe('Keychain', () => {
    it('round trip: set, read back, delete, then missing', async () => {
        const k = new Keychain(async () => fakeModule().module);
        expect(await k.get('github/access')).toEqual({ kind: 'missing' });
        expect(await k.set('github/access', 'ghu_secret')).toEqual({ ok: true });
        expect(await k.get('github/access')).toEqual({ kind: 'value', value: 'ghu_secret' });
        expect(await k.delete('github/access')).toEqual({ ok: true });
        expect(await k.get('github/access')).toEqual({ kind: 'missing' });
    });

    it('deleting what is not there is fine: the entry is gone either way', async () => {
        const k = new Keychain(async () => fakeModule().module);
        expect(await k.delete('workstation/tynn.ai')).toEqual({ ok: true });
    });

    it('a keychain that fails reads as UNAVAILABLE, never as missing: a locked keychain is not signed out', async () => {
        const k = new Keychain(async () => fakeModule(new Map(), new Error('The name org.freedesktop.secrets was not provided')).module);
        const read = await k.get('tynn/pairing');
        expect(read.kind).toBe('unavailable');
        if (read.kind === 'unavailable') expect(read.reason).toMatch(/org\.freedesktop\.secrets/);
        expect((await k.probe()).ok).toBe(false);
    });

    it('with no keychain a secret is REFUSED, in words; the reason never carries the value', async () => {
        const k = new Keychain(async () => fakeModule(new Map(), new Error('no secret service')).module);
        const wrote = await k.set('tynn/pairing', 'gpk_the_secret');
        expect(wrote.ok).toBe(false);
        if (!wrote.ok) {
            expect(wrote.reason).toMatch(/keyring/i);
            expect(wrote.reason).not.toContain('gpk_the_secret');
        }
        expect((await k.delete('tynn/pairing')).ok).toBe(false);
    });

    it('a native module that cannot load is the same refusal, never a crash', async () => {
        const k = new Keychain(async () => { throw new Error('Cannot find module keyring-linux-x64-gnu'); });
        expect((await k.get('tynn/pairing')).kind).toBe('unavailable');
        expect((await k.set('tynn/pairing', 'x')).ok).toBe(false);
        const p = await k.probe();
        expect(p.ok).toBe(false);
        if (!p.ok) expect(p.reason).toMatch(/keyring-linux-x64-gnu/);
    });

    it('an empty secret is refused: reading it back could not tell it from nothing', async () => {
        const f = fakeModule();
        const k = new Keychain(async () => f.module);
        expect((await k.set('tynn/pairing', '')).ok).toBe(false);
        expect(f.store.size).toBe(0);
    });

    it('the probe reads a reserved entry that is never written: a missing entry means the keychain ANSWERED', async () => {
        const f = fakeModule();
        expect(await new Keychain(async () => f.module).probe()).toEqual({ ok: true });
        expect(f.store.size).toBe(0);
    });

    it('a native module loaded once is kept', async () => {
        const load = vi.fn(async () => fakeModule().module);
        const k = new Keychain(load);
        await k.get('tynn/pairing');
        await k.get('tynn/pairing');
        expect(load).toHaveBeenCalledTimes(1);
    });
});

/**
 * THE SAME install/start flow (linux-keyring.ts, genie#1436), never a second one: the host hands it its own facts — "ready"
 * only when the keychain really answers, not when Chromium's store is fine.
 */
describe('openHostKeychain on Linux', () => {
    function rig(input: { listing?: string; daemon?: boolean; startWorks?: boolean; keychainUp?: boolean }) {
        const ran: string[][] = [];
        let up = input.keychainUp ?? false;
        let listing = input.listing ?? '';
        // One module, kept by the Keychain: whether it answers is read at each call, so a started daemon is seen.
        const module = fakeModule(new Map(), () => (up ? null : new Error('The name org.freedesktop.secrets was not provided'))).module;
        const opened = openHostKeychain({
            platform: 'linux',
            load: async () => module,
            exists: (file) => input.daemon === true && file.endsWith('gnome-keyring-daemon'),
            pathEnv: '/usr/bin',
            run: async (binary, args) => {
                ran.push([binary, ...args]);
                if (binary === 'busctl') return { exitCode: 0, stdout: listing, stderr: '' };
                if (input.startWorks) { up = true; listing = 'org.freedesktop.secrets 123 x'; }
                return { exitCode: 0, stdout: '', stderr: '' };
            },
        });
        return { opened, ran };
    }

    it('the keychain answers → ready', async () => {
        const { keyring, state } = await rig({ keychainUp: true, listing: 'org.freedesktop.secrets 123 x', daemon: true }).opened;
        expect(state()).toBe('ready');
        expect(keyring?.view()).toBeNull();
    });

    it('nothing installed → not-installed, and the card offers the install', async () => {
        const { state, keyring } = await rig({}).opened;
        expect(state()).toBe('not-installed');
        expect(keyring?.view()?.state).toBe('not-installed');
    });

    it('installed, not running → not-running; the existing Fix starts it and re-reads the REAL keychain → ready', async () => {
        const r = rig({ daemon: true, startWorks: true });
        const { keyring, state } = await r.opened;
        expect(state()).toBe('not-running');
        await keyring!.fix();
        expect(r.ran.some((c) => c.includes('StartServiceByName') || c.join(' ').includes('org.freedesktop.secrets'))).toBe(true);
        expect(state()).toBe('ready');
    });

    it('a running daemon whose keychain still refuses (locked) → refused. Never restart-needed: the host has no Chromium store to pick', async () => {
        const { state } = await rig({ daemon: true, listing: 'org.freedesktop.secrets 123 x', keychainUp: false }).opened;
        expect(state()).toBe('refused');
    });
});

describe('openHostKeychain off Linux', () => {
    it('Windows: no install flow; the probe alone says ready or refused', async () => {
        const up = await openHostKeychain({ platform: 'win32', load: async () => fakeModule().module });
        expect(up.state()).toBe('ready');
        expect(up.keyring).toBeNull();
        const down = await openHostKeychain({ platform: 'win32', load: async () => fakeModule(new Map(), new Error('no credential store')).module });
        expect(down.state()).toBe('refused');
    });
});

describe('genie-host.ts opens it, and hands no secret over the link', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('opens the host keychain, says its state in the log, and survives one that will not open', () => {
        const host = strip(readFileSync('src/main/genie-host.ts', 'utf8'));
        expect(host).toMatch(/openHostKeychain\(\{/);
        expect(host).toMatch(/keychain: \$\{/);
    });

    it('nothing in the engine protocol carries a keychain read or write yet (cut c decides who asks)', () => {
        expect(strip(readFileSync('src/core/engine-protocol.ts', 'utf8'))).not.toMatch(/keychain/i);
    });

    it('the bundle keeps the native module external, and the installer unpacks it', () => {
        expect(readFileSync('vite.main.config.ts', 'utf8')).toMatch(/external: \[[^\]]*'@napi-rs\/keyring'/);
        expect(readFileSync('electron-builder.yml', 'utf8')).toMatch(/\*\*\/node_modules\/@napi-rs\/keyring\*\/\*\*/);
    });
});
