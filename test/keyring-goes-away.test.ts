import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { openHostKeychain } from '../src/main/host-keychain.js';
import { Keychain, type KeyringModule } from '../src/main/keychain.js';
import { KeyringService } from '../src/main/keyring-service.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * A KEYRING THAT GOES AWAY WHILE GENIE RUNS IS SAID, WITH NO RESTART. The host read the session's keyring at launch and when the card's button was pressed, and at no other
 * time. A keyring gone later left secrets reading as unavailable and nobody told until the next launch: the owner's "visible state" rule, and the failure they reported on
 * Omarchy. So the keychain says when its answer changes, and the host reads the facts again.
 */

const NAME = 'tynn/pairing';
const OWNED = 'org.freedesktop.secrets 1234 gnome-keyring-d genie :1.5 user@1000.service - -';
const ACTIVATABLE = 'org.freedesktop.secrets - - - (activatable) - -';

function world() {
    const w = { answers: true, listing: OWNED, installed: true, wakesOnRead: false, listings: 0, reads: 0 };
    const load = async (): Promise<KeyringModule> => ({
        AsyncEntry: class {
            async getPassword() {
                w.reads += 1;
                if (!w.answers && w.wakesOnRead) { w.answers = true; w.listing = OWNED; }
                if (!w.answers) throw new Error('The name org.freedesktop.secrets was not provided by any .service files');
                return 'value';
            }
            async setPassword() { if (!w.answers) throw new Error('gone'); }
            async deletePassword() { if (!w.answers) throw new Error('gone'); return true; }
        },
    }) as never;
    const run = async (binary: string) => {
        if (binary !== 'busctl') return { exitCode: 0, stdout: '', stderr: '' };
        w.listings += 1;
        return { exitCode: 0, stdout: w.listing, stderr: '' };
    };
    const exists = (file: string) => w.installed && file.endsWith('/gnome-keyring-daemon');
    return { w, load, run, exists };
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

async function opened(platform: NodeJS.Platform = 'linux') {
    const { w, load, run, exists } = world();
    const keychain = new Keychain(load);
    const host = await openHostKeychain({ keychain, platform, run, exists, pathEnv: '/usr/bin' });
    let readied = 0;
    const service = new KeyringService(Promise.resolve(host.keyring), { onReady: () => { readied += 1; } });
    const heard: unknown[] = [];
    service.onEvent((dump) => heard.push(dump.view));
    await settle();
    return { w, keychain, host, service, heard, readied: () => readied };
}

describe('the keychain says when its answer changes', () => {
    function plain() {
        const { w, load } = world();
        const keychain = new Keychain(load);
        const said: boolean[] = [];
        keychain.onAnswerChange((answers) => said.push(answers));
        return { w, keychain, said };
    }

    it('once per change, not per read', async () => {
        const { w, keychain, said } = plain();
        await keychain.get(NAME);
        await keychain.get(NAME);
        expect(said, 'an answer that has not changed').toEqual([true]);
        w.answers = false;
        await keychain.get(NAME);
        await keychain.get(NAME);
        expect(said).toEqual([true, false]);
        w.answers = true;
        await keychain.get(NAME);
        expect(said).toEqual([true, false, true]);
    });

    it('a write and a delete that fail count, as a probe does', async () => {
        const { w, keychain, said } = plain();
        await keychain.probe();
        w.answers = false;
        await keychain.set(NAME, 'x');
        expect(said).toEqual([true, false]);
        w.answers = true;
        await keychain.delete(NAME);
        expect(said).toEqual([true, false, true]);
    });

    it('an empty value, refused before the keychain is asked, says nothing about the keychain', async () => {
        const { keychain, said } = plain();
        await keychain.set(NAME, '');
        expect(said).toEqual([]);
    });
});

describe('the keyring goes away while Genie runs', () => {
    it('CONTROL: a keychain that answers has no card', async () => {
        const o = await opened();
        await o.keychain.get(NAME);
        await settle();
        expect(o.service.dump().view).toBeNull();
    });

    it('a read that finds it gone brings the card, with nobody pressing anything and no restart', async () => {
        const o = await opened();
        o.w.answers = false;
        o.w.listing = '';
        expect((await o.keychain.get(NAME)).kind).toBe('unavailable');
        await settle();
        expect(o.service.dump().view).toMatchObject({ state: 'not-running' });
        expect(o.service.dump().canKeepSecrets).toBe(false);
        expect(o.heard.at(-1)).toMatchObject({ state: 'not-running' });
    });

    it('a daemon still there that gives no answer is the locked card', async () => {
        const o = await opened();
        o.w.answers = false;
        await o.keychain.get(NAME);
        await settle();
        expect(o.service.dump().view).toMatchObject({ state: 'refused' });
    });

    it('uninstalled: the card says so and names the install', async () => {
        const o = await opened();
        o.w.answers = false;
        o.w.listing = '';
        o.w.installed = false;
        await o.keychain.get(NAME);
        await settle();
        expect(o.service.dump().view).toMatchObject({ state: 'not-installed' });
    });

    it('a service the bus can start again is started by the re-check, and shows no card', async () => {
        const o = await opened();
        o.w.answers = false;
        o.w.listing = ACTIVATABLE;
        o.w.wakesOnRead = true;
        const heardBefore = o.heard.length;
        // The read itself fails here by having been made before the service woke; the re-check's own probe wakes it.
        o.w.wakesOnRead = false;
        await o.keychain.get(NAME);
        o.w.wakesOnRead = true;
        await settle();
        expect(o.service.dump().view).toBeNull();
        expect(o.heard.slice(heardBefore).filter((v) => v !== null), 'no card flashes up').toEqual([]);
    });

    it('it comes back by itself: the next read that answers takes the card away, and whoever waits for secrets hears', async () => {
        const o = await opened();
        o.w.answers = false;
        o.w.listing = '';
        await o.keychain.get(NAME);
        await settle();
        expect(o.service.dump().view).not.toBeNull();
        o.w.answers = true;
        o.w.listing = OWNED;
        await o.keychain.get(NAME);
        await settle();
        expect(o.service.dump().view).toBeNull();
        expect(o.service.dump().canKeepSecrets).toBe(true);
        expect(o.readied()).toBe(1);
    });

    it('a burst of failing reads reads the session once: a dead keyring is not a busy loop', async () => {
        const o = await opened();
        o.w.answers = false;
        o.w.listing = '';
        const before = o.w.listings;
        await Promise.all(Array.from({ length: 50 }, () => o.keychain.get(NAME)));
        await settle();
        await Promise.all(Array.from({ length: 50 }, () => o.keychain.get(NAME)));
        await settle();
        expect(o.w.listings - before).toBe(1);
    });

    it('the button still works from the card that came this way', async () => {
        const o = await opened();
        o.w.answers = false;
        o.w.listing = '';
        await o.keychain.get(NAME);
        await settle();
        o.w.answers = true;
        o.w.listing = OWNED;
        await o.service.call('fix', []);
        await settle();
        expect(o.service.dump().view).toBeNull();
    });

    it('a window linked at the time sees the card arrive', async () => {
        const o = await opened();
        const dir = await mkdtemp(join(tmpdir(), 'keyring-away-'));
        try {
            const TOKEN = 'a'.repeat(64);
            const server = new SessionEngineServer({ token: TOKEN, build: 'test', keyring: o.service });
            const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
            server.attach(host);
            const [hostSide, windowSide] = memoryPair();
            server.accept(hostSide);
            const client = new SessionEngineClient();
            await client.connect(windowSide, TOKEN);
            const replica = client.keyring();
            let changes = 0;
            replica.onChange(() => { changes += 1; });
            await settle();
            expect(replica.view()).toBeNull();
            o.w.answers = false;
            o.w.listing = '';
            await o.keychain.get(NAME);
            await settle();
            expect(replica.view()).toMatchObject({ state: 'not-running' });
            expect(changes).toBeGreaterThan(0);
        } finally {
            await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
    });

    it('off Linux there is no card to raise, and the state follows the answer', async () => {
        const o = await opened('win32');
        expect(o.host.state()).toBe('ready');
        o.w.answers = false;
        await o.keychain.get(NAME);
        await settle();
        expect(o.host.state()).toBe('refused');
        expect(o.service.dump().view).toBeNull();
    });
});
