import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { KeyringService } from '../src/main/keyring-service.js';
import { LinuxKeyring, type KeyringPorts } from '../src/main/linux-keyring.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { until } from './helpers/until.js';

/**
 * THE KEYRING CARD READS THE HOST (P3.4 cut c). The secrets are in the host's keychain, so whether they can be kept is the host's to say. The window's Chromium store
 * says nothing about it. A window shows what the host found, and its button runs the install or start in the host. There is no "Restart Genie" step: a libsecret
 * client sees a daemon as soon as it runs, so once it answers, the accounts read again by themselves.
 */

const TOKEN = 'a'.repeat(64);
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'keyring-host-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

type Facts = Awaited<ReturnType<KeyringPorts['facts']>>;
const HEALTHY: Facts = { installed: true, owned: true, activatable: true, backend: 'gnome_libsecret', available: true };

async function hostKeyring(start: Facts) {
    const state = { facts: start, execs: [] as string[][], relaunches: 0 };
    const ports: KeyringPorts = {
        platform: 'linux',
        facts: async () => state.facts,
        plan: async () => ({ pm: 'pacman', packages: ['gnome-keyring', 'libsecret'], run: ['pkexec', 'pacman', '-S', 'gnome-keyring'], manual: 'sudo pacman -S gnome-keyring' }) as never,
        exec: async (argv: readonly string[]) => { state.execs.push([...argv]); state.facts = HEALTHY; return { code: 0, stdout: '', stderr: '' }; },
        relaunch: () => { state.relaunches += 1; },
    } as never;
    return { state, keyring: await LinuxKeyring.open(ports) };
}

async function linked(service: KeyringService) {
    const server = new SessionEngineServer({ token: TOKEN, build: 'test', keyring: service });
    const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
    server.attach(host);
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide);
    const client = new SessionEngineClient();
    await client.connect(windowSide, TOKEN);
    return { client, replica: client.keyring() };
}

describe('a window shows what the host found', () => {
    it('no daemon running: the card is there as the window connects, in the host’s words', async () => {
        const { keyring } = await hostKeyring({ ...HEALTHY, owned: false, available: false, backend: 'basic_text' });
        const { replica } = await linked(new KeyringService(keyring));
        expect(replica.view()).toMatchObject({ state: 'not-running' });
        expect(replica.canKeepSecrets()).toBe(false);
    });

    it('CONTROL: a keychain that answers has no card, and secrets can be kept', async () => {
        const { keyring } = await hostKeyring(HEALTHY);
        const { replica } = await linked(new KeyringService(keyring));
        expect(replica.view()).toBeNull();
        expect(replica.canKeepSecrets()).toBe(true);
    });

    it('the button runs IN THE HOST: the keyring starts, the card goes, and the window hears it', async () => {
        const { keyring, state } = await hostKeyring({ ...HEALTHY, owned: false, available: false, backend: 'basic_text' });
        const { replica } = await linked(new KeyringService(keyring));
        let changes = 0;
        replica.onChange(() => { changes += 1; });
        await replica.fix();
        expect(state.execs.length).toBeGreaterThan(0);
        await until(() => replica.view() === null);
        expect(replica.view()).toBeNull();
        expect(replica.canKeepSecrets()).toBe(true);
        expect(changes).toBeGreaterThan(0);
    });

    it('NO RESTART OF GENIE IS ASKED FOR: the host needs none', async () => {
        const { keyring, state } = await hostKeyring({ ...HEALTHY, owned: false, available: false, backend: 'basic_text' });
        const { replica } = await linked(new KeyringService(keyring));
        await replica.fix();
        expect(state.relaunches).toBe(0);
    });

    it('not installed: the install runs in the host, and a failure comes back in the card', async () => {
        const { keyring, state } = await hostKeyring({ installed: false, owned: false, activatable: false, backend: 'basic_text', available: false });
        const { replica } = await linked(new KeyringService(keyring));
        expect(replica.view()).toMatchObject({ state: 'not-installed' });
        await replica.fix();
        expect(state.execs[0]?.[0]).toBe('pkexec');
    });

    it('still opening: no card yet, and nothing claims secrets cannot be kept', async () => {
        let open!: (k: LinuxKeyring) => void;
        const { replica } = await linked(new KeyringService(new Promise<LinuxKeyring>((r) => { open = r; })));
        expect(replica.view()).toBeNull();
        const { keyring } = await hostKeyring({ ...HEALTHY, owned: false, available: false, backend: 'basic_text' });
        open(keyring);
        await until(() => replica.view() !== null);
        expect(replica.view()).toMatchObject({ state: 'not-running' });
    });

    it('a window with no link has no card, and a click says why it did nothing', async () => {
        const replica = new SessionEngineClient().keyring();
        expect(replica.view()).toBeNull();
        await expect(replica.fix()).rejects.toThrow();
    });

    it('only what the card needs can be asked for', async () => {
        const { keyring } = await hostKeyring(HEALTHY);
        const { client } = await linked(new KeyringService(keyring));
        expect((await client.call('engine.keyring', ['relaunch', []])).ok).toBe(false);
    });
});

describe('when the keychain comes to answer', () => {
    it('whoever reads secrets reads again, once, with nobody restarting anything', async () => {
        const { keyring } = await hostKeyring({ ...HEALTHY, owned: false, available: false, backend: 'basic_text' });
        let ready = 0;
        const service = new KeyringService(keyring, { onReady: () => { ready += 1; } });
        const { replica } = await linked(service);
        await replica.fix();
        await until(() => ready > 0);
        expect(ready).toBe(1);
        await replica.fix();
        await new Promise((r) => setTimeout(r, 20));
        expect(ready, 'it was already ready').toBe(1);
    });

    it('CONTROL: a change that leaves it not ready wakes nobody', async () => {
        const { keyring, state } = await hostKeyring({ installed: false, owned: false, activatable: false, backend: 'basic_text', available: false });
        let ready = 0;
        new KeyringService(keyring, { onReady: () => { ready += 1; } });
        const ports = state;
        ports.facts = { installed: false, owned: false, activatable: false, backend: 'basic_text', available: false };
        await new Promise((r) => setTimeout(r, 10));
        expect(ready).toBe(0);
    });

    it('a keychain already answering at open wakes nobody: nothing was waiting on it', async () => {
        const { keyring } = await hostKeyring(HEALTHY);
        let ready = 0;
        new KeyringService(keyring, { onReady: () => { ready += 1; } });
        await new Promise((r) => setTimeout(r, 10));
        expect(ready).toBe(0);
    });
});

describe('where it is wired', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('with a host, main shows the host’s card; only its own engine reads Chromium’s store for it', () => {
        const main = strip(readFileSync('src/main/main.ts', 'utf8'));
        expect(main).toMatch(/keyring = agentEngineLink\.client\.keyring\(\)/);
        const host = strip(readFileSync('src/main/genie-host.ts', 'utf8'));
        expect(host).toMatch(/new KeyringService\(/);
        expect(host).toMatch(/onReady:/);
    });

    it('a window hears the keychain is back, and tries its one-time move again', () => {
        expect(strip(readFileSync('src/main/main.ts', 'utf8'))).toMatch(/moveSecretsAgain\(\)/);
    });
});
