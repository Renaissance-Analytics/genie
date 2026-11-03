import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { migrateSecrets, type MigrationBook, type MigrationState } from '../src/main/keychain-migration.js';
import { hostTynnPorts } from '../src/main/host-tynn-account.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { settleStaleLegacyPairing, TynnAccount, tynnPairingSource, type TynnAccountPorts } from '../src/main/tynn-account.js';
import { TynnAccountService } from '../src/main/tynn-account-service.js';
import type { PrivateCredentialStore } from '../src/main/private-credentials.js';

/**
 * THE TYNN ACCOUNT IS THE HOST'S (P3.4 cut c; plan §13). The pairing token is in the keychain as `tynn/pairing`, the file says who
 * is signed in and holds no token, the host does the sign-in exchange, and a window reads a replica: it can ask the account to do
 * anything it did, and it never holds the token.
 */

const HOST = 'https://tynn.test';
const TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'ab'.repeat(32)}`;
const CODE = 'c'.repeat(64);
const USER = { id: 'user-7', name: 'Wish', email: 'w@example.invalid' };
const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const TOKEN_FREE = /gpk_/;

let dir: string;
let file: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tynn-host-'));
    mkdirSync(join(dir, 'credentials'));
    file = join(dir, 'credentials', 'tynn.json');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

/** A plain-file store: the private store's ACL work is PowerShell on Windows, and not what these tests are about. */
const plainStore: PrivateCredentialStore = {
    prepare: async () => {},
    migrate: async () => {},
    write: async (path, text) => { writeFileSync(path, text); },
};

function keychainFake() {
    const held = new Map<string, string>();
    const k = {
        held, locked: false, setFails: false, sets: 0, deletes: 0,
        probe: async () => (k.locked ? { ok: false as const, reason: 'locked' } : { ok: true as const }),
        get: async (name: string) => { if (k.locked) return { kind: 'unavailable' as const, reason: 'locked' }; const value = held.get(name); return value === undefined ? { kind: 'missing' as const } : { kind: 'value' as const, value }; },
        set: async (name: string, value: string) => { if (k.locked || k.setFails) return { ok: false as const, reason: 'locked' }; k.sets += 1; held.set(name, value); return { ok: true as const }; },
        delete: async (name: string) => { if (k.locked) return { ok: false as const, reason: 'locked' }; k.deletes += 1; held.delete(name); return { ok: true as const }; },
    };
    return k;
}

/** Tynn: a cookie exchanges for the pairing; the bearer answers who it is. */
function tynnFake() {
    const t = {
        calls: [] as Array<{ url: string; method: string; cookie: string | null; authorization: string | null }>,
        revoked: 0,
        fetch: async (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => {
            const headers = new Headers(init.headers);
            t.calls.push({ url, method: init.method, cookie: headers.get('cookie'), authorization: headers.get('authorization') });
            const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
            if (url.endsWith('/api/v1/pairing-token') && init.method === 'DELETE') { t.revoked += 1; return reply(200, { revoked: true }); }
            if (headers.get('cookie')?.includes(`genie_token=${CODE}`)) return reply(200, { ...USER, pairing_token: TOKEN, pairing_scopes: SCOPES });
            if (headers.get('authorization') === `Bearer ${TOKEN}`) return reply(200, USER);
            return reply(404, {});
        },
    };
    return t;
}

function open(keychain: ReturnType<typeof keychainFake>, tynn: ReturnType<typeof tynnFake>, over: Partial<TynnAccountPorts> = {}) {
    return TynnAccount.open({
        ...hostTynnPorts({ file, host: () => HOST, secrets: keychain, fetch: ((url: string, init: never) => tynn.fetch(url, init)) as never }),
        credentials: plainStore,
        ...over,
    });
}
const disk = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('the pairing token is in the keychain', () => {
    it('a sign-in puts it there; the file holds who is signed in and no token, sealed or not', async () => {
        const k = keychainFake();
        const account = await open(k, tynnFake());
        expect(await account.signIn(CODE)).toMatchObject({ ok: true });
        expect(k.held.get('tynn/pairing')).toBe(TOKEN);
        expect(disk()).toMatchObject({ state: 'signed-in', userId: USER.id, host: HOST });
        expect(disk().tokenEnc).toBeUndefined();
        expect(readFileSync(file, 'utf8')).not.toMatch(TOKEN_FREE);
    });

    it('a new launch restores it from the keychain and confirms it with Tynn', async () => {
        const k = keychainFake();
        const tynn = tynnFake();
        await (await open(k, tynn)).signIn(CODE);
        const again = await open(k, tynn);
        expect(again.status()).toMatchObject({ signedIn: true });
        expect(again.userId()).toBe(USER.id);
    });

    it('a sign-out removes it, says so on disk and revokes it', async () => {
        const k = keychainFake();
        const tynn = tynnFake();
        const account = await open(k, tynn);
        await account.signIn(CODE);
        await account.signOut();
        expect(k.held.has('tynn/pairing')).toBe(false);
        expect(disk().state).toBe('signed-out');
        expect(tynn.revoked).toBe(1);
        expect(account.savedUserId()).toBeNull();
    });

    it('no keychain: refused BEFORE the code is exchanged, so the code is not spent', async () => {
        const k = keychainFake();
        k.locked = true;
        const tynn = tynnFake();
        const result = await (await open(k, tynn)).signIn(CODE);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('keyring') });
        expect(tynn.calls).toEqual([]);
    });

    it('the keychain takes nothing during the exchange: not signed in, the key is revoked, nothing is on disk', async () => {
        const k = keychainFake();
        k.setFails = true;
        const tynn = tynnFake();
        const account = await open(k, tynn);
        expect((await account.signIn(CODE)).ok).toBe(false);
        expect(account.status().signedIn).toBe(false);
        expect(tynn.revoked).toBe(1);
        expect(existsSync(file)).toBe(false);
    });
});

describe('a locked keychain is never read as signed out', () => {
    async function signedInThenLocked() {
        const k = keychainFake();
        const tynn = tynnFake();
        await (await open(k, tynn)).signIn(CODE);
        const before = readFileSync(file, 'utf8');
        k.locked = true;
        return { k, tynn, before, account: await open(k, tynn) };
    }

    it('the sign-in survives: the file is not touched, and the entry is not removed', async () => {
        const { k, before, account } = await signedInThenLocked();
        expect(account.status().signedIn).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(k.held.get('tynn/pairing')).toBe(TOKEN);
    });

    it('whose it is stays known, so an agent’s own key can say why it is locked rather than "sign in"', async () => {
        const { account } = await signedInThenLocked();
        expect(account.savedUserId()).toBe(USER.id);
    });

    it('when the keychain answers again, a reload signs in with no pairing', async () => {
        const { k, account } = await signedInThenLocked();
        k.locked = false;
        await account.reload();
        expect(account.status().signedIn).toBe(true);
    });

    it('CONTROL: an entry that is really gone, with a file that says signed in, is signed out too; a reload changes nothing', async () => {
        const k = keychainFake();
        const tynn = tynnFake();
        await (await open(k, tynn)).signIn(CODE);
        k.held.clear();
        const account = await open(k, tynn);
        expect(account.status().signedIn).toBe(false);
        await account.reload();
        expect(account.status().signedIn).toBe(false);
    });
});

describe('whose account it is, from the record', () => {
    it.each([
        ['it says signed out, whatever else it holds', { version: 1, state: 'signed-out', host: HOST, userId: USER.id, scopes: SCOPES }],
        ['it is for another Tynn', { version: 1, state: 'signed-in', host: 'https://elsewhere.example', userId: USER.id, scopes: SCOPES }],
    ])('nobody when %s', async (_label, record) => {
        writeFileSync(file, JSON.stringify(record));
        const k = keychainFake();
        k.held.set('tynn/pairing', TOKEN);
        const account = await open(k, tynnFake());
        expect(account.savedUserId()).toBeNull();
        expect(account.status().signedIn).toBe(false);
    });
});

describe('the host does the exchange, with no Electron session', () => {
    it('the code goes as a Cookie on the exchange and on nothing after it', async () => {
        const tynn = tynnFake();
        const account = await open(keychainFake(), tynn);
        await account.signIn(CODE);
        await account.request('/api/v1/projects', { method: 'GET' });
        const exchange = tynn.calls.find((c) => c.cookie !== null);
        expect(exchange?.cookie).toBe(`genie_token=${CODE}`);
        expect(exchange?.authorization).toBeNull();
        const later = tynn.calls.at(-1);
        expect(later?.cookie).toBeNull();
        expect(later?.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('a refused exchange leaves no cookie for the next call', async () => {
        const tynn = tynnFake();
        const account = await open(keychainFake(), tynn);
        expect((await account.signIn('d'.repeat(64))).ok).toBe(false);
        await account.signIn(CODE);
        expect(tynn.calls.filter((c) => c.cookie?.includes('d'.repeat(64)))).toHaveLength(1);
    });

    it('the module imports nothing of Electron', () => {
        expect(readFileSync('src/main/host-tynn-account.ts', 'utf8')).not.toMatch(/from 'electron'/);
        expect(readFileSync('src/main/tynn-account.ts', 'utf8')).not.toMatch(/from 'electron'/);
    });
});

describe('a window reads a replica, and never holds the token', () => {
    async function linked(k = keychainFake(), tynn = tynnFake()) {
        const account = await open(k, tynn);
        const service = new TynnAccountService(account);
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', tynn: service });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const seen: string[] = [];
        windowSide.onMessage((line: string) => seen.push(line));
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'a'.repeat(64));
        return { k, tynn, account, service, client, replica: client.tynn(), seen };
    }

    it('a window that connects to a signed-in host reads signed in at once', async () => {
        const k = keychainFake();
        const tynn = tynnFake();
        await (await open(k, tynn)).signIn(CODE);
        const { replica } = await linked(k, tynn);
        expect(replica.status()).toMatchObject({ signedIn: true, user: { name: USER.name } });
        expect(replica.userId()).toBe(USER.id);
        expect(replica.host()).toBe(HOST);
    });

    it('a sign-in through it reaches the host, and it hears the change', async () => {
        const { replica, account } = await linked();
        let changes = 0;
        replica.onChange(() => { changes += 1; });
        expect(await replica.signIn(CODE)).toMatchObject({ ok: true });
        expect(account.status().signedIn).toBe(true);
        for (let i = 0; i < 20 && !replica.status().signedIn; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(replica.status().signedIn).toBe(true);
        expect(changes).toBeGreaterThan(0);
    });

    it('a request answers as the account does, with the same status and body', async () => {
        const { replica } = await linked();
        await replica.signIn(CODE);
        const res = await replica.request('/api/v1/me', { method: 'GET' });
        expect([res.ok, res.status]).toEqual([true, 200]);
        expect(await res.json()).toMatchObject({ id: USER.id });
    });

    it('a 404 stays a 404 across the link, and is not an error', async () => {
        const tynn = tynnFake();
        const { replica } = await linked(keychainFake(), tynn);
        await replica.signIn(CODE);
        tynn.fetch = async () => new Response('{}', { status: 404 });
        const res = await replica.request('/api/v1/nothing', { method: 'GET' });
        expect([res.ok, res.status]).toEqual([false, 404]);
    });

    it('signed out, a request is refused in the account’s own words', async () => {
        const { replica } = await linked();
        await expect(replica.request('/api/v1/me', { method: 'GET' })).rejects.toThrow('Sign in to Tynn first');
    });

    it('an aborted request rejects at once, in the window', async () => {
        const { replica } = await linked();
        await replica.signIn(CODE);
        const controller = new AbortController();
        controller.abort();
        await expect(replica.request('/api/v1/me', { method: 'GET', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('it opens the browser in the window; the host has nothing to open it with', async () => {
        const { client } = await linked();
        const opened: string[] = [];
        const { url } = await client.tynn({ openExternal: async (link) => { opened.push(link); } }).startSignIn();
        expect(url).toContain(HOST);
        expect(opened).toEqual([url]);
    });

    it('nothing the link carries holds the token: not the dump, not an event, not any answer', async () => {
        const { replica, service, client, seen } = await linked();
        await replica.signIn(CODE);
        expect(JSON.stringify(service.dump())).not.toMatch(TOKEN_FREE);
        const asked = await client.call('engine.tynn', ['request', ['/api/v1/me', { method: 'GET' }]]);
        expect(JSON.stringify(asked)).not.toMatch(TOKEN_FREE);
        // CONTROL: this is the wire, and the gauge reads it: the state did cross, with the account's id in it.
        expect(seen.join('\n')).toContain(USER.id);
        expect(seen.join('\n')).not.toMatch(TOKEN_FREE);
    });

    it('only what a window needs can be asked for', async () => {
        const { client } = await linked();
        const asked = await client.call('engine.tynn', ['credential', []]);
        expect(asked.ok).toBe(false);
    });

    it('a window with no link answers signed out, and refuses a request', async () => {
        const replica = new SessionEngineClient().tynn();
        expect(replica.status().signedIn).toBe(false);
        await expect(replica.request('/api/v1/me', { method: 'GET' })).rejects.toThrow();
    });
});

describe('TWO STORES: the sign-in in credentials/tynn.json and an older tynn.json beside it (the beta.56 upgrade acceptance)', () => {
    // As the real store behaves: two stores are ambiguous, and it refuses. That refusal read as an unreadable seal, so the pairing never moved, and Genie came up signed out, saying nothing.
    const strictStore: PrivateCredentialStore = {
        prepare: async () => {},
        migrate: async (legacy, into) => {
            if (!existsSync(legacy)) return;
            if (existsSync(into)) throw new Error('Private Tynn credential permissions could not be secured.');
            renameSync(legacy, into);
        },
        write: async (path, text) => { writeFileSync(path, text); },
    };
    const cipher = { decrypt: (bytes: Buffer) => bytes.toString().replace(/^sealed:/, '') };
    const OLD_TOKEN = `gpk_${'9'.repeat(26)}.${'c'.repeat(64)}`;
    /** The shape beta.56 really left: version, state, host, userId, scopes, tokenEnc, usedCodes. */
    const record = (token: string | null) => JSON.stringify({ version: 1, state: 'signed-in', host: HOST, userId: USER.id, scopes: SCOPES, ...(token ? { tokenEnc: Buffer.from(`sealed:${token}`).toString('base64') } : {}), usedCodes: ['abc'] });
    const legacyFile = () => join(dirname(file), 'legacy-tynn.json');
    const memoryBook = (): MigrationBook => { const states: Record<string, MigrationState> = {}; return { read: async () => ({ ...states }), write: async (name, state) => { states[name] = state; } }; };
    const vaultOver = (k: ReturnType<typeof keychainFake>) => ({ store: (name: string, value: string) => k.set(name, value), compare: async (name: string, value: string) => (k.held.get(name) === value ? 'same' as const : k.held.has(name) ? 'different' as const : 'missing' as const) });
    const hasToken = (path: string) => readFileSync(path, 'utf8').includes('tokenEnc');

    it('the current sign-in moves, byte for byte, and the older one does not win', async () => {
        writeFileSync(file, record(TOKEN));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        const k = keychainFake();
        const source = tynnPairingSource({ file, legacyFile: legacyFile(), cipher, store: strictStore });
        expect(await migrateSecrets([source], vaultOver(k) as never, memoryBook())).toEqual([{ name: 'tynn/pairing', status: 'moved' }]);
        expect(k.held.get('tynn/pairing')).toBe(TOKEN);
    });

    it('and then no seal is left anywhere: not the current one, not the older one', async () => {
        writeFileSync(file, record(TOKEN));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        await migrateSecrets([tynnPairingSource({ file, legacyFile: legacyFile(), cipher, store: strictStore })], vaultOver(keychainFake()) as never, memoryBook());
        expect(hasToken(file)).toBe(false);
        expect(existsSync(legacyFile())).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ state: 'signed-in', userId: USER.id });
    });

    it('a read-back that differs keeps both: the rule that nothing goes before the read-back holds for the older one too', async () => {
        writeFileSync(file, record(TOKEN));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        const vault = { store: async () => ({ ok: true as const }), compare: async () => 'different' as const };
        await migrateSecrets([tynnPairingSource({ file, legacyFile: legacyFile(), cipher, store: strictStore })], vault as never, memoryBook());
        expect(hasToken(file)).toBe(true);
        expect(existsSync(legacyFile())).toBe(true);
    });

    it('it says so, with no token in the words', async () => {
        writeFileSync(file, record(TOKEN));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        const lines: string[] = [];
        await tynnPairingSource({ file, legacyFile: legacyFile(), cipher, store: strictStore, log: (l) => lines.push(l) }).old.read();
        expect(lines.join('\n')).toMatch(/older/);
        expect(lines.join('\n')).not.toContain('gpk_');
    });

    it('a seal that will not open says why, by name, with no value', async () => {
        writeFileSync(file, record(TOKEN));
        const lines: string[] = [];
        const read = await tynnPairingSource({ file, cipher: { decrypt: () => { throw new Error('Error while decrypting'); } }, store: strictStore, log: (l) => lines.push(l) }).old.read();
        expect(read.kind).toBe('unreadable');
        expect(lines.join('\n')).toMatch(/tynn\/pairing.*Error while decrypting/);
    });

    it('CONTROL: only the older file: it still comes across, as it always did', async () => {
        writeFileSync(legacyFile(), record(TOKEN));
        const k = keychainFake();
        await migrateSecrets([tynnPairingSource({ file, legacyFile: legacyFile(), cipher, store: strictStore })], vaultOver(k) as never, memoryBook());
        expect(k.held.get('tynn/pairing')).toBe(TOKEN);
        expect(existsSync(legacyFile())).toBe(false);
    });

    it('moved long ago, an older file beside it: it is stale, and it goes, and a move that already ran never reads it again', async () => {
        writeFileSync(file, record(null));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        await settleStaleLegacyPairing({ file, legacyFile: legacyFile() });
        expect(existsSync(legacyFile())).toBe(false);
    });

    it('CONTROL: the current one still sealed: not yet, the move does that after its read-back', async () => {
        writeFileSync(file, record(TOKEN));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        await settleStaleLegacyPairing({ file, legacyFile: legacyFile() });
        expect(existsSync(legacyFile())).toBe(true);
    });

    it('CONTROL: a current file it cannot read, or none: the older one is kept', async () => {
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        await settleStaleLegacyPairing({ file, legacyFile: legacyFile() });
        expect(existsSync(legacyFile())).toBe(true);
        writeFileSync(file, '{ not json');
        await settleStaleLegacyPairing({ file, legacyFile: legacyFile() });
        expect(existsSync(legacyFile())).toBe(true);
    });

    it('an account opening with both is not refused: a window running its own engine reads the current one', async () => {
        const k = keychainFake();
        await k.set('tynn/pairing', TOKEN);
        writeFileSync(file, record(null));
        writeFileSync(legacyFile(), record(OLD_TOKEN));
        const account = await open(k, tynnFake(), { legacyFile: legacyFile(), credentials: strictStore });
        expect(account.status().signedIn).toBe(true);
    });

    it('wired: main settles the stale file first, and what stays where it was reaches a log someone can read', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/await settleStaleLegacyPairing\(/);
        expect(main).toMatch(/secretsLog:/);
        expect(readFileSync('src/main/compose.ts', 'utf8')).toMatch(/input\.secretsLog/);
    });
});

describe('the pairing an older Genie sealed moves to the keychain', () => {
    const cipher = { decrypt: (bytes: Buffer) => bytes.toString().replace(/^sealed:/, '') };
    const sealedFile = (token = TOKEN) => writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-in', host: HOST, userId: USER.id, scopes: SCOPES, usedCodes: ['abc'], tokenEnc: Buffer.from(`sealed:${token}`).toString('base64') }));
    const memoryBook = (): MigrationBook => { const states: Record<string, MigrationState> = {}; return { read: async () => ({ ...states }), write: async (name, state) => { states[name] = state; } }; };

    function vaultOver(k: ReturnType<typeof keychainFake>) {
        return { store: (name: string, value: string) => k.set(name, value), compare: async (name: string, value: string) => (k.held.get(name) === value ? 'same' as const : 'different' as const) };
    }

    it('it moves, the file keeps everything but the token, and a reload signs in', async () => {
        sealedFile();
        const k = keychainFake();
        const account = await open(k, tynnFake());
        expect(account.status().signedIn).toBe(false);
        const source = tynnPairingSource({ file, cipher, store: plainStore });
        expect(await migrateSecrets([source], vaultOver(k) as never, memoryBook())).toEqual([{ name: 'tynn/pairing', status: 'moved' }]);
        expect(k.held.get('tynn/pairing')).toBe(TOKEN);
        expect(disk().tokenEnc).toBeUndefined();
        expect(disk()).toMatchObject({ state: 'signed-in', userId: USER.id, usedCodes: ['abc'] });
        await account.reload();
        expect(account.status().signedIn).toBe(true);
    });

    it('the host never deletes the sealed copy just by opening over it', async () => {
        sealedFile();
        const before = readFileSync(file, 'utf8');
        await open(keychainFake(), tynnFake());
        expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('a seal that cannot be opened is not moved and not deleted', async () => {
        sealedFile();
        const source = tynnPairingSource({ file, cipher: { decrypt: () => { throw new Error('another OS user'); } }, store: plainStore });
        expect((await source.old.read()).kind).toBe('unreadable');
        expect(disk().tokenEnc).toBeDefined();
    });

    it('what opens to something that is not a pairing token is not moved', async () => {
        sealedFile('not-a-token');
        expect((await tynnPairingSource({ file, cipher, store: plainStore }).old.read()).kind).toBe('unreadable');
    });

    it('no sealed token, or no file: nothing to move', async () => {
        expect((await tynnPairingSource({ file, cipher, store: plainStore }).old.read()).kind).toBe('none');
        writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-out', host: HOST }));
        expect((await tynnPairingSource({ file, cipher, store: plainStore }).old.read()).kind).toBe('none');
    });
});
