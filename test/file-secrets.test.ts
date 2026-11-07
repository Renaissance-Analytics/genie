import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYCHAIN_SERVICE, Keychain, type KeyringModule } from '../src/main/keychain.js';
import { openHostKeychain } from '../src/main/host-keychain.js';
import { isOwnerOnlyFile, restrictPrivateFile } from '../src/main/private-credentials.js';
import {
    SECRET_FORMAT_VERSION, SECRET_IV_BYTES, SECRET_KEY_BYTES, SECRET_TAG_BYTES,
    chooseSecretBackend, keyFileTooOpen, openFileSecrets, openSealedSecret, openSecretKeychain, sealSecret, secretFileName, secretsDir,
} from '../src/main/file-secrets.js';

/**
 * THE FILE SECRET BACKEND (the host split, P10.1a): a host with no OS keychain (a cloud workstation) keeps genie-host's
 * secrets as files, one per entry under `<home>/secrets/`, sealed with AES-256-GCM under a key the operator provides. It is
 * chosen ONLY by `GENIE_SECRET_BACKEND=file` with `GENIE_SECRET_KEY_FILE`; nothing falls back to it, and it falls back to
 * nothing. Every value here is made up.
 */

const MADE_UP = ['made-up-secret-one', 'made-up-secret-two', 'made-up-secret-é-three'] as const;
const [ONE, TWO, THREE] = MADE_UP;

// No value ever reaches a log line.
const logged: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
    spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
});
afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    const lines = logged.splice(0);
    for (const value of MADE_UP) expect(lines.filter((l) => l.includes(value)), 'a secret value in a log line').toEqual([]);
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function rig() {
    const root = await mkdtemp(join(tmpdir(), 'genie-file-secrets-'));
    roots.push(root);
    const home = join(root, 'home');
    const keyFile = join(root, 'secret.key');
    const key = randomBytes(32);
    await writeFile(keyFile, key, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    return { root, home, keyFile, key, dir: secretsDir(home) };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** On Windows the ACL reader is its own row below; everywhere else these rows use the real mode check. */
const ownerOnlyOk = { ownerOnly: async () => true };
async function fileKeychain(r: Rig, keyFile = r.keyFile): Promise<Keychain> {
    const module = await openFileSecrets({ keyFile, dir: r.dir, ...ownerOnlyOk });
    return new Keychain(async () => module);
}
const refusal = (opening: Promise<unknown>): Promise<string> => opening.then(() => 'it opened', (error: unknown) => (error instanceof Error ? error.message : String(error)));

function walk(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    } catch { return []; }
}

function osModule() {
    const store = new Map<string, string>();
    let loads = 0;
    class AsyncEntry {
        readonly #key: string;
        constructor(service: string, username: string) { this.#key = `${service}/${username}`; }
        async getPassword(): Promise<string | null> { return store.get(this.#key) ?? null; }
        async setPassword(value: string): Promise<void> { store.set(this.#key, value); }
        async deletePassword(): Promise<boolean> { return store.delete(this.#key); }
    }
    const load = async (): Promise<KeyringModule> => { loads += 1; return { AsyncEntry } as unknown as KeyringModule; };
    return { load, store, loads: () => loads };
}

describe('round trip', () => {
    it('set, read back, overwrite, delete, then missing; one file per entry under <home>/secrets', async () => {
        const r = await rig();
        const k = await fileKeychain(r);
        expect(await k.get('github/access')).toEqual({ kind: 'missing' });
        expect(await k.set('github/access', ONE)).toEqual({ ok: true });
        expect(await k.set('tynn/pairing', TWO)).toEqual({ ok: true });
        expect(await k.get('github/access')).toEqual({ kind: 'value', value: ONE });
        expect(await k.get('tynn/pairing')).toEqual({ kind: 'value', value: TWO });
        expect(await k.set('github/access', THREE)).toEqual({ ok: true });
        expect(await k.get('github/access')).toEqual({ kind: 'value', value: THREE });

        const files = walk(r.root).filter((f) => f !== r.keyFile);
        expect(files.length).toBe(2);
        for (const f of files) expect(resolve(f).startsWith(resolve(r.dir))).toBe(true);
        // Sealed: no value is in any file.
        for (const f of files) for (const value of MADE_UP) expect(readFileSync(f).includes(Buffer.from(value, 'utf8'))).toBe(false);

        expect(await k.delete('github/access')).toEqual({ ok: true });
        expect(await k.get('github/access')).toEqual({ kind: 'missing' });
        expect(await k.delete('github/access')).toEqual({ ok: true });
        expect(await k.get('tynn/pairing')).toEqual({ kind: 'value', value: TWO });
        expect((await k.probe()).ok).toBe(true);
    });

    it('a second process with the same key reads what the first wrote', async () => {
        const r = await rig();
        await (await fileKeychain(r)).set('workstation/abc', ONE);
        expect(await (await fileKeychain(r)).get('workstation/abc')).toEqual({ kind: 'value', value: ONE });
    });

    it('a secret is written 0600 on POSIX, the directory 0700', async () => {
        if (process.platform === 'win32') return;
        const r = await rig();
        await (await fileKeychain(r)).set('github/access', ONE);
        const { statSync } = await import('node:fs');
        expect(statSync(r.dir).mode & 0o777).toBe(0o700);
        for (const f of walk(r.dir)) expect(statSync(f).mode & 0o777).toBe(0o600);
    });
});

describe('a tampered file is refused in words, and nothing is returned', () => {
    async function written(r: Rig) {
        const k = await fileKeychain(r);
        await k.set('github/access', ONE);
        const [file] = walk(r.dir);
        if (!file) throw new Error('no file written');
        return { k, file, bytes: await readFile(file) };
    }

    it('one flipped byte of the ciphertext: unavailable, said, no value', async () => {
        const r = await rig();
        const { k, file, bytes } = await written(r);
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0x01;
        await writeFile(file, changed);
        const read = await k.get('github/access');
        expect(read.kind).toBe('unavailable');
        if (read.kind !== 'unavailable') return;
        expect(read.reason).toMatch(/could not be decrypted/);
        expect(read.reason).not.toContain(ONE);
    });

    it('a changed tag, a cut-short file and an unknown version are refused the same way', async () => {
        const r = await rig();
        const { k, file, bytes } = await written(r);
        const tag = Buffer.from(bytes);
        tag[1 + SECRET_IV_BYTES] = (tag[1 + SECRET_IV_BYTES] ?? 0) ^ 0xff;
        const versioned = Buffer.from(bytes);
        versioned[0] = 9;
        for (const bad of [tag, bytes.subarray(0, 10), versioned]) {
            await writeFile(file, bad);
            const read = await k.get('github/access');
            expect(read.kind).toBe('unavailable');
            if (read.kind === 'unavailable') expect(read.reason).not.toContain(ONE);
        }
    });
});

describe('a file is bound to its entry: swapped or renamed, it is refused', () => {
    it('two entries\' files exchanged: both refused in words, neither value returned', async () => {
        const r = await rig();
        const k = await fileKeychain(r);
        await k.set('github/access', ONE);
        await k.set('github/refresh', TWO);
        const a = join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'github/access'));
        const b = join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'github/refresh'));
        const [bytesA, bytesB] = [await readFile(a), await readFile(b)];
        await writeFile(a, bytesB);
        await writeFile(b, bytesA);
        for (const name of ['github/access', 'github/refresh'] as const) {
            const read = await k.get(name);
            expect(read.kind, name).toBe('unavailable');
            if (read.kind !== 'unavailable') continue;
            expect(read.reason).toMatch(/could not be decrypted/);
            expect(read.reason).not.toContain(ONE);
            expect(read.reason).not.toContain(TWO);
        }
        // Positive control: put back, both read.
        await writeFile(a, bytesA);
        await writeFile(b, bytesB);
        expect(await k.get('github/access')).toEqual({ kind: 'value', value: ONE });
        expect(await k.get('github/refresh')).toEqual({ kind: 'value', value: TWO });
    });

    it('one entry\'s file copied under another entry\'s name: refused', async () => {
        const r = await rig();
        const k = await fileKeychain(r);
        await k.set('github/access', ONE);
        await writeFile(join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'tynn/pairing')), await readFile(join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'github/access'))));
        const read = await k.get('tynn/pairing');
        expect(read.kind).toBe('unavailable');
        if (read.kind === 'unavailable') expect(read.reason).not.toContain(ONE);
    });
});

describe('the wrong key is refused', () => {
    it('a file sealed under one key does not open under another: unavailable, said, no value', async () => {
        const r = await rig();
        await (await fileKeychain(r)).set('github/access', ONE);
        const otherKey = join(r.root, 'other.key');
        await writeFile(otherKey, randomBytes(32), { mode: 0o600 });
        await chmod(otherKey, 0o600);
        const read = await (await fileKeychain(r, otherKey)).get('github/access');
        expect(read.kind).toBe('unavailable');
        if (read.kind !== 'unavailable') return;
        expect(read.reason).toMatch(/could not be decrypted/);
        expect(read.reason).not.toContain(ONE);
    });

    it('a key that is not 32 raw bytes is refused at start, in words (a hex key is 64 bytes)', async () => {
        const r = await rig();
        await writeFile(r.keyFile, randomBytes(32).toString('hex'));
        await chmod(r.keyFile, 0o600);
        const why = await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir, ...ownerOnlyOk }));
        expect(why).toContain(r.keyFile);
        expect(why).toMatch(/64 bytes/);
        expect(why).toMatch(/32/);
    });

    it('a key file that does not exist is refused at start, with the path: never created, never skipped', async () => {
        const r = await rig();
        const absent = join(r.root, 'absent.key');
        const why = await refusal(openFileSecrets({ keyFile: absent, dir: r.dir, ...ownerOnlyOk }));
        expect(why).toContain(absent);
        expect(why).toMatch(/does not exist/);
        expect(walk(r.root).map((f) => resolve(f))).toEqual([resolve(r.keyFile)]);
    });
});

describe('a key file others can read is refused in words', () => {
    it('the rule: any group or other bit is too open; 0600 and 0400 are not', () => {
        expect(keyFileTooOpen(0o100644)).toBe(true);
        expect(keyFileTooOpen(0o100640)).toBe(true);
        expect(keyFileTooOpen(0o100604)).toBe(true);
        expect(keyFileTooOpen(0o100600)).toBe(false);
        expect(keyFileTooOpen(0o100400)).toBe(false);
    });

    it('POSIX, by the mode it reads: 0644 refused with the path and the fix; 0600 opens (positive control)', async () => {
        const r = await rig();
        const loose = await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir, platform: 'linux', statMode: async () => 0o100644 }));
        expect(loose).toContain(r.keyFile);
        expect(loose).toMatch(/0644/);
        expect(loose).toMatch(/chmod 600/);
        expect(await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir, platform: 'linux', statMode: async () => 0o100600 }))).toBe('it opened');
    });

    it.skipIf(process.platform === 'win32')('POSIX, a real file: chmod 0644 refused; chmod 0600 opens (positive control)', async () => {
        const r = await rig();
        await chmod(r.keyFile, 0o644);
        const loose = await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir }));
        expect(loose).toContain(r.keyFile);
        expect(loose).toMatch(/0644/);
        await chmod(r.keyFile, 0o600);
        expect(await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir }))).toBe('it opened');
    });

    it('Windows, by the ACL reader: not owner-only refused with the path and the fix; owner-only opens', async () => {
        const r = await rig();
        const asked: string[] = [];
        const open = (answer: boolean) => openFileSecrets({ keyFile: r.keyFile, dir: r.dir, platform: 'win32', ownerOnly: async (f) => { asked.push(f); return answer; }, restrictDir: async () => {} });
        const loose = await refusal(open(false));
        expect(loose).toContain(r.keyFile);
        expect(loose).toMatch(/owner-only/);
        expect(await refusal(open(true))).toBe('it opened');
        expect(asked.map((f) => resolve(f))).toEqual([resolve(r.keyFile), resolve(r.keyFile)]);
    });

    it.skipIf(process.platform !== 'win32')('Windows, a real file: inherited ACL refused; restricted to its owner, it opens (positive control)', async () => {
        const r = await rig();
        expect(await isOwnerOnlyFile(r.keyFile)).toBe(false);
        // Reading changes nothing: asked again, the same answer.
        expect(await isOwnerOnlyFile(r.keyFile)).toBe(false);
        const loose = await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir }));
        expect(loose).toContain(r.keyFile);
        expect(loose).toMatch(/owner-only/);
        await restrictPrivateFile(r.keyFile);
        expect(await isOwnerOnlyFile(r.keyFile)).toBe(true);
        expect(await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir }))).toBe('it opened');
    }, 180_000);
});

describe('the secrets folder is its owner\'s only: an owner-only ACL on Windows, 0700 on POSIX', () => {
    it('Windows: the folder goes through the private-directory restriction, by its full path, before any entry', async () => {
        const r = await rig();
        const restricted: string[] = [];
        await openFileSecrets({ keyFile: r.keyFile, dir: r.dir, platform: 'win32', ...ownerOnlyOk, restrictDir: async (d) => { restricted.push(d); } });
        expect(restricted).toEqual([resolve(r.dir)]);
    });

    it('Windows: a folder that cannot be restricted refuses the start, in words with its path', async () => {
        const r = await rig();
        const why = await refusal(openFileSecrets({ keyFile: r.keyFile, dir: r.dir, platform: 'win32', ...ownerOnlyOk, restrictDir: async () => { throw new Error('Private Tynn credential permissions could not be secured.'); } }));
        expect(why).toContain(resolve(r.dir));
        expect(why).toMatch(/owner-only/);
    });

    it('POSIX: no ACL restriction is asked for; the folder is made 0700', async () => {
        const r = await rig();
        const restricted: string[] = [];
        await openFileSecrets({ keyFile: r.keyFile, dir: r.dir, platform: 'linux', statMode: async () => 0o100600, restrictDir: async (d) => { restricted.push(d); } });
        expect(restricted).toEqual([]);
        if (process.platform !== 'win32') expect((await import('node:fs')).statSync(r.dir).mode & 0o777).toBe(0o700);
    });

    it.skipIf(process.platform !== 'win32')('Windows, a real folder: after the open its ACL is protected, with one rule (positive control: before, it inherits)', async () => {
        const r = await rig();
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { mkdir } = await import('node:fs/promises');
        const acl = async (dir: string): Promise<string> => {
            const script = `$a=[IO.Directory]::GetAccessControl([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(dir, 'utf16le').toString('base64')}')));'protected='+$a.AreAccessRulesProtected+';rules='+@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])).Count`;
            const { stdout } = await promisify(execFile)(join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60_000 });
            return stdout.trim();
        };
        await mkdir(r.dir, { recursive: true });
        expect(await acl(r.dir)).toMatch(/^protected=False;/);
        await openFileSecrets({ keyFile: r.keyFile, dir: r.dir, ...ownerOnlyOk });
        expect(await acl(r.dir)).toBe('protected=True;rules=1');
    }, 180_000);
});

describe('which backend: only GENIE_SECRET_BACKEND=file with GENIE_SECRET_KEY_FILE', () => {
    it('unset or empty: the OS keychain; a key file alone does not choose the file backend', () => {
        expect(chooseSecretBackend({}, '/h')).toEqual({ kind: 'os' });
        expect(chooseSecretBackend({ GENIE_SECRET_BACKEND: '' }, '/h')).toEqual({ kind: 'os' });
        expect(chooseSecretBackend({ GENIE_SECRET_KEY_FILE: '/k' }, '/h')).toEqual({ kind: 'os' });
    });

    it('file with a key file: the file backend, under <home>/secrets', () => {
        expect(chooseSecretBackend({ GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: '/k' }, '/h')).toEqual({ kind: 'file', keyFile: '/k', dir: secretsDir('/h') });
        expect(secretsDir('/h')).toBe(join('/h', 'secrets'));
    });

    it('file without a key file, or a backend it does not know: refused in words, never the keychain', () => {
        const noKey = chooseSecretBackend({ GENIE_SECRET_BACKEND: 'file' }, '/h');
        expect(noKey.kind).toBe('refused');
        if (noKey.kind === 'refused') expect(noKey.reason).toMatch(/GENIE_SECRET_KEY_FILE/);
        const unknown = chooseSecretBackend({ GENIE_SECRET_BACKEND: 'vault', GENIE_SECRET_KEY_FILE: '/k' }, '/h');
        expect(unknown.kind).toBe('refused');
        if (unknown.kind === 'refused') expect(unknown.reason).toMatch(/GENIE_SECRET_BACKEND.*vault/);
    });
});

describe('no fallback, in either direction', () => {
    it('backend unset and no OS keychain: the write is refused, and no file is written anywhere', async () => {
        const r = await rig();
        const failing = async (): Promise<KeyringModule> => { throw new Error('no keyring here'); };
        const opened = await openSecretKeychain({}, r.home, { loadOs: failing });
        expect(opened.kind).toBe('os');
        if (opened.kind === 'refused') return;
        expect((await opened.keychain.set('github/access', ONE)).ok).toBe(false);
        expect((await opened.keychain.get('github/access')).kind).toBe('unavailable');
        expect(walk(r.root).map((f) => resolve(f))).toEqual([resolve(r.keyFile)]);
    });

    it('file backend misconfigured: refused, and the OS keychain is never loaded', async () => {
        const r = await rig();
        const looseKey = join(r.root, 'loose.key');
        await writeFile(looseKey, randomBytes(32));
        const shortKey = join(r.root, 'short.key');
        await writeFile(shortKey, randomBytes(16), { mode: 0o600 });
        await chmod(shortKey, 0o600);
        const notADir = join(r.root, 'home-file');
        await writeFile(notADir, 'x');
        const cases: Array<{ env: NodeJS.ProcessEnv; home: string; ownerOnly?: (f: string) => Promise<boolean>; platform?: NodeJS.Platform }> = [
            { env: { GENIE_SECRET_BACKEND: 'file' }, home: r.home },
            { env: { GENIE_SECRET_BACKEND: 'keychain-please', GENIE_SECRET_KEY_FILE: r.keyFile }, home: r.home },
            { env: { GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: join(r.root, 'absent.key') }, home: r.home, ...ownerOnlyOk },
            { env: { GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: shortKey }, home: r.home, ...ownerOnlyOk },
            { env: { GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: looseKey }, home: r.home, platform: 'win32', ownerOnly: async () => false },
            // <home>/secrets cannot be made: home is a file.
            { env: { GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: r.keyFile }, home: notADir, ...ownerOnlyOk },
        ];
        for (const c of cases) {
            const os = osModule();
            const opened = await openSecretKeychain(c.env, c.home, { loadOs: os.load, ...(c.ownerOnly ? { ownerOnly: c.ownerOnly } : {}), ...(c.platform ? { platform: c.platform } : {}) });
            expect(opened.kind, JSON.stringify(c.env)).toBe('refused');
            if (opened.kind === 'refused') expect(opened.reason.length).toBeGreaterThan(20);
            expect(os.loads(), JSON.stringify(c.env)).toBe(0);
            expect(os.store.size).toBe(0);
        }
    });

    it('POSIX, a real loose key through the whole open: refused, the OS keychain never loaded', async () => {
        if (process.platform === 'win32') return;
        const r = await rig();
        await chmod(r.keyFile, 0o644);
        const os = osModule();
        const opened = await openSecretKeychain({ GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: r.keyFile }, r.home, { loadOs: os.load });
        expect(opened.kind).toBe('refused');
        if (opened.kind === 'refused') expect(opened.reason).toContain(r.keyFile);
        expect(os.loads()).toBe(0);
    });

    it('the file backend, configured: writes go to files, never to the OS keychain', async () => {
        const r = await rig();
        const os = osModule();
        const opened = await openSecretKeychain({ GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: r.keyFile }, r.home, { loadOs: os.load, ...ownerOnlyOk });
        expect(opened.kind).toBe('file');
        if (opened.kind === 'refused') return;
        expect(await opened.keychain.set('github/access', ONE)).toEqual({ ok: true });
        expect(await opened.keychain.get('github/access')).toEqual({ kind: 'value', value: ONE });
        expect(os.loads()).toBe(0);
        expect(walk(r.dir).length).toBe(1);
    });

    it('genie-host on the file backend offers no Secret Service install, and runs nothing', async () => {
        const r = await rig();
        const ran: string[][] = [];
        const keychain = await fileKeychain(r);
        const opened = await openHostKeychain({ keychain, platform: 'linux', backend: 'file', run: async (binary, args) => { ran.push([binary, ...args]); return { exitCode: 0, stdout: '', stderr: '' }; } });
        expect(opened.keyring).toBeNull();
        expect(opened.state()).toBe('ready');
        expect(ran).toEqual([]);
    });
});

describe('the desktop default is unchanged', () => {
    it('backend unset: the OS keychain is what is opened and written, and no secrets directory appears', async () => {
        const r = await rig();
        const os = osModule();
        const opened = await openSecretKeychain({ GENIE_SECRET_KEY_FILE: r.keyFile }, r.home, { loadOs: os.load });
        expect(opened.kind).toBe('os');
        if (opened.kind === 'refused') return;
        expect(await opened.keychain.set('github/access', ONE)).toEqual({ ok: true });
        expect(os.store.get(`${KEYCHAIN_SERVICE}/github/access`)).toBe(ONE);
        expect(walk(r.root).map((f) => resolve(f))).toEqual([resolve(r.keyFile)]);
    });

    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('only genie-host chooses a backend; the window builds the OS keychain as before', () => {
        const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
        const using = files('src').filter((f) => /file-secrets\.js['"]|GENIE_SECRET_BACKEND/.test(strip(readFileSync(f, 'utf8')))).map((f) => relative('.', f).split('\\').join('/')).sort();
        expect(using).toEqual(['src/main/file-secrets.ts', 'src/main/genie-host.ts']);
        const host = strip(readFileSync('src/main/genie-host.ts', 'utf8'));
        expect(host).toMatch(/openSecretKeychain\(process\.env, home\)/);
        // A refusal stops the host, in its words: it never runs on with no secrets, or with the other store.
        expect(host).toMatch(/kind === 'refused'[\s\S]{0,300}process\.exit\(1\)/);
        expect(host).not.toMatch(/new Keychain\(\)/);
    });
});

describe('entry names cannot escape <home>/secrets', () => {
    const hostile = ['../../../escape', '..\\..\\escape', '/etc/escape', 'C:\\escape', 'tynn/agent/../../..', 'a/b/c', '.', '..', 'x\0y'];

    it('every name maps to one fixed-shape file name: hex, no separator, no dot path', () => {
        for (const name of hostile) expect(secretFileName(KEYCHAIN_SERVICE, name)).toMatch(/^[0-9a-f]{64}\.secret$/);
        const names = new Set(hostile.map((n) => secretFileName(KEYCHAIN_SERVICE, n)));
        expect(names.size).toBe(hostile.length);
        // Case matters in a name; Windows' file names ignore it, so the mapping must not lean on case.
        expect(secretFileName(KEYCHAIN_SERVICE, 'device/A')).not.toBe(secretFileName(KEYCHAIN_SERVICE, 'device/a'));
    });

    it('written for real, every hostile name lands inside <home>/secrets and reads back', async () => {
        const r = await rig();
        const k = await fileKeychain(r);
        for (const name of hostile) expect(await k.set(`tynn/agent/${name}`, ONE)).toEqual({ ok: true });
        const files = walk(r.root).filter((f) => resolve(f) !== resolve(r.keyFile));
        expect(files.length).toBe(hostile.length);
        for (const f of files) expect(relative(resolve(r.dir), resolve(f))).toMatch(/^[0-9a-f]{64}\.secret$/);
        for (const name of hostile) expect(await k.get(`tynn/agent/${name}`)).toEqual({ kind: 'value', value: ONE });
    });
});

/** The additional authenticated data the format binds a file to: "genie-secret:" and the entry's 64-hex name hash (its file name without `.secret`). */
const aadFor = (name: string): Buffer => Buffer.from(`genie-secret:${secretFileName(KEYCHAIN_SERVICE, name).slice(0, 64)}`, 'utf8');

describe('the on-disk format v2: [version 2][IV 12][GCM tag 16][ciphertext], raw bytes, bound to its entry; the key 32 raw bytes', () => {
    it('the constants are the format', () => {
        expect([SECRET_FORMAT_VERSION, SECRET_IV_BYTES, SECRET_TAG_BYTES, SECRET_KEY_BYTES]).toEqual([2, 12, 16, 32]);
    });

    it('a file Genie writes opens by the layout alone, with plain AES-256-GCM and the entry as AAD; without the AAD it does not', async () => {
        const r = await rig();
        await (await fileKeychain(r)).set('github/access', THREE);
        const blob = await readFile(join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'github/access')));
        expect(blob[0]).toBe(2);
        expect(blob.length).toBe(1 + 12 + 16 + Buffer.byteLength(THREE, 'utf8'));
        const decipher = createDecipheriv('aes-256-gcm', r.key, blob.subarray(1, 13));
        decipher.setAAD(aadFor('github/access'));
        decipher.setAuthTag(blob.subarray(13, 29));
        expect(Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8')).toBe(THREE);
        // The binding is real: the same bytes with no AAD fail the tag.
        const bare = createDecipheriv('aes-256-gcm', r.key, blob.subarray(1, 13));
        bare.setAuthTag(blob.subarray(13, 29));
        bare.update(blob.subarray(29));
        expect(() => bare.final()).toThrow();
    });

    it('a file sealed by hand in that layout reads back through Genie', async () => {
        const r = await rig();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', r.key, iv);
        cipher.setAAD(aadFor('github/refresh'));
        const body = Buffer.concat([cipher.update(TWO, 'utf8'), cipher.final()]);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(r.dir, { recursive: true });
        await writeFile(join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'github/refresh')), Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), body]));
        expect(await (await fileKeychain(r)).get('github/refresh')).toEqual({ kind: 'value', value: TWO });
    });

    it('a version-1 file (no binding) is refused, in words', async () => {
        const r = await rig();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', r.key, iv);
        const body = Buffer.concat([cipher.update(TWO, 'utf8'), cipher.final()]);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(r.dir, { recursive: true });
        await writeFile(join(r.dir, secretFileName(KEYCHAIN_SERVICE, 'github/refresh')), Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]));
        const read = await (await fileKeychain(r)).get('github/refresh');
        expect(read.kind).toBe('unavailable');
        if (read.kind === 'unavailable') { expect(read.reason).toMatch(/version 1/); expect(read.reason).not.toContain(TWO); }
    });

    it('seal and open: a fresh IV each time, either one opens under its AAD, and under another AAD neither does', () => {
        const key = randomBytes(32);
        const aad = aadFor('github/access');
        const a = sealSecret(key, Buffer.from(ONE, 'utf8'), aad);
        const b = sealSecret(key, Buffer.from(ONE, 'utf8'), aad);
        expect(a.equals(b)).toBe(false);
        expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
        expect(openSealedSecret(key, a, aad).toString('utf8')).toBe(ONE);
        expect(openSealedSecret(key, b, aad).toString('utf8')).toBe(ONE);
        expect(() => openSealedSecret(randomBytes(32), a, aad)).toThrow(/could not be decrypted/);
        expect(() => openSealedSecret(key, a, aadFor('github/refresh'))).toThrow(/could not be decrypted/);
    });

    it('nothing but entries is in the directory after writes (no stage left behind)', async () => {
        const r = await rig();
        const k = await fileKeychain(r);
        for (let i = 0; i < 5; i++) await k.set('github/access', `${ONE}-${i}`);
        expect((await readdir(r.dir)).every((n) => /^[0-9a-f]{64}\.secret$/.test(n))).toBe(true);
        expect((await readdir(r.dir)).length).toBe(1);
    });
});
