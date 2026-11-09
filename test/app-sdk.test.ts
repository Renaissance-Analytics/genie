import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, NotGrantedError, NotInGenieError, RefusedError, type ElementsOf, type GenieApp } from '../packages/app-sdk/src/index.js';
import { BRIDGE_CALLS, BRIDGE_EVENTS } from '../packages/app-sdk/src/generated.js';
import { APP_BRIDGE, KIND_SPECS } from '../src/core/catalog.js';
import { PACKAGE_MANIFEST_FILE } from '../src/core/plugin-integrity.js';
import { renderAppSdkTypes } from '../src/core/sdk-types.js';
import { checkPackageCommand } from '../src/main/check-package.js';
import { GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V6 (Tynn #571; spec .ai/plans/specs/gapps-v2.md, section 4): `@genie/app-sdk`, a typed wrapper over the bridge
 * V5 built, its types generated from the catalog and drift-checked like docs/sdk; and `npm run check:package`, the host's
 * own checks on a folder, printing the host's own reasons.
 */

/**
 * THE TYPE TEST. It is compiled by `npm run typecheck`, never run: an app that lists two elements can call them with their
 * own typed arguments, and nothing else.
 */
export async function typeTest(genie: GenieApp<ElementsOf<'knowledge' | 'checkIssues'>>): Promise<void> {
    await genie.call('knowledge', { action: 'search', query: 'x', limit: 5 });
    await genie.call('knowledge', { action: 'list' }, { workspaceId: 'w1' });
    await genie.call('checkIssues'); // Every argument is optional, so none need be passed.
    await genie.call('checkIssues', { refresh: true }, { workspaceId: 'w1' });
    // @ts-expect-error not an element this app lists
    await genie.call('plan', {});
    // @ts-expect-error not one of the tool's actions
    await genie.call('knowledge', { action: 'erase' });
    // @ts-expect-error `action` is required
    await genie.call('knowledge', {});
    // @ts-expect-error `limit` is a number
    await genie.call('knowledge', { action: 'list', limit: 'five' });
    // @ts-expect-error a terminal id is not something an app can pass
    await genie.call('knowledge', { action: 'list', terminalId: 'someone' });
    const scope: 'workstation' | readonly string[] = genie.me().scope;
    void scope;
}

type Listener = (data: unknown) => void;

function fakeBridge(me: Record<string, unknown> = { packageId: 'com.example.notes', version: '1.0.0', preview: false, scope: 'workstation', publisher: 'sha256:abc', granted: ['knowledge'] }) {
    const listeners = new Map<string, Set<Listener>>();
    const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => (method === 'app.me' ? me : { asked: method }));
    const bridge = {
        request,
        on: (event: string, fn: Listener) => {
            const set = listeners.get(event) ?? new Set();
            listeners.set(event, set);
            set.add(fn);
            return () => { set.delete(fn); };
        },
    };
    return { bridge, request, fire: (event: string, data: unknown) => { for (const fn of listeners.get(event) ?? []) fn(data); }, listening: (event: string) => listeners.get(event)?.size ?? 0 };
}

const inWindow = (bridge: unknown) => vi.stubGlobal('genieApp', bridge);
afterEach(() => { vi.unstubAllGlobals(); });

describe('connect', () => {
    it('outside a Genie app window it throws NotInGenieError', async () => {
        await expect(connect()).rejects.toBeInstanceOf(NotInGenieError);
    });

    it('a window Genie refused says why, as a RefusedError', async () => {
        const fake = fakeBridge();
        fake.request.mockRejectedValueOnce(new Error('this token is not for this app'));
        inWindow(fake.bridge);
        const error = await connect().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RefusedError);
        expect((error as RefusedError).reason).toBe('this token is not for this app');
    });
});

describe('me and can', () => {
    it('me() says who the app is; `granted` is not part of it', async () => {
        inWindow(fakeBridge().bridge);
        const genie = await connect();
        expect(genie.me()).toEqual({ packageId: 'com.example.notes', version: '1.0.0', preview: false, scope: 'workstation', publisher: 'sha256:abc' });
    });

    it('can() is what the grant allows now, following both events', async () => {
        const fake = fakeBridge();
        inWindow(fake.bridge);
        const genie = await connect();
        expect(genie.can('knowledge')).toBe(true);
        expect(genie.can('checkIssues')).toBe(false);
        fake.fire('app.grantChanged', { granted: ['checkIssues'], scope: ['w1'] });
        expect(genie.can('knowledge')).toBe(false);
        expect(genie.can('checkIssues')).toBe(true);
        expect(genie.me().scope).toEqual(['w1']);
        fake.fire('app.catalogChanged', { revision: 9, granted: [] });
        expect(genie.can('checkIssues')).toBe(false);
    });

    it('a change that arrives while connecting is not overwritten by the older answer', async () => {
        const fake = fakeBridge();
        let answer: (v: unknown) => void = () => undefined;
        fake.request.mockImplementationOnce(() => new Promise((ok) => { answer = ok; }));
        inWindow(fake.bridge);
        const connecting = connect();
        await vi.waitFor(() => expect(fake.request).toHaveBeenCalled());
        fake.fire('app.grantChanged', { granted: [], scope: 'workstation' });
        answer({ packageId: 'x', version: '1', preview: false, scope: 'workstation', publisher: 'p', granted: ['knowledge'] });
        expect((await connecting).can('knowledge')).toBe(false);
    });
});

describe('call', () => {
    it('sends the element and its args, and answers with what it returned', async () => {
        const fake = fakeBridge();
        fake.request.mockResolvedValueOnce({ packageId: 'x', version: '1', preview: false, scope: 'workstation', publisher: 'p', granted: [] });
        inWindow(fake.bridge);
        const genie = await connect();
        fake.request.mockResolvedValueOnce({ found: 1 });
        await expect(genie.call('knowledge', { action: 'list' })).resolves.toEqual({ found: 1 });
        expect(fake.request).toHaveBeenLastCalledWith('app.call', { elementId: 'knowledge', args: { action: 'list' } });
    });

    it('a workspace goes with the call when one is given', async () => {
        const fake = fakeBridge();
        inWindow(fake.bridge);
        const genie = await connect();
        await genie.call('checkIssues', { refresh: true }, { workspaceId: 'w1' });
        expect(fake.request).toHaveBeenLastCalledWith('app.call', { elementId: 'checkIssues', args: { refresh: true }, workspaceId: 'w1' });
        await genie.call('checkIssues');
        expect(fake.request).toHaveBeenLastCalledWith('app.call', { elementId: 'checkIssues', args: {} });
    });

    it('not granted is NotGrantedError naming the element; anything else is RefusedError with the reason', async () => {
        const fake = fakeBridge();
        inWindow(fake.bridge);
        const genie = await connect();
        fake.request.mockRejectedValueOnce(new Error('NotGrantedError(checkIssues): com.example.notes was not granted "checkIssues"'));
        const notGranted = await genie.call('checkIssues').catch((e: unknown) => e);
        expect(notGranted).toBeInstanceOf(NotGrantedError);
        expect((notGranted as NotGrantedError).elementId).toBe('checkIssues');
        expect((notGranted as NotGrantedError).message).toMatch(/was not granted/);
        fake.request.mockRejectedValueOnce(new Error('com.example.notes is turned off'));
        const refused = await genie.call('checkIssues').catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(RefusedError);
        expect((refused as RefusedError).reason).toBe('com.example.notes is turned off');
    });
});

describe('storage and events', () => {
    it('reads and writes through the bridge', async () => {
        const fake = fakeBridge();
        inWindow(fake.bridge);
        const genie = await connect();
        fake.request.mockResolvedValueOnce({ n: 1 });
        await expect(genie.storage.get<{ n: number }>('a')).resolves.toEqual({ n: 1 });
        expect(fake.request).toHaveBeenLastCalledWith('app.storage.get', { key: 'a' });
        fake.request.mockResolvedValueOnce(true);
        await expect(genie.storage.set('a', [1])).resolves.toBeUndefined();
        expect(fake.request).toHaveBeenLastCalledWith('app.storage.set', { key: 'a', value: [1] });
        fake.request.mockResolvedValueOnce(true);
        await expect(genie.storage.delete('a')).resolves.toBe(true);
        expect(fake.request).toHaveBeenLastCalledWith('app.storage.delete', { key: 'a' });
        fake.request.mockResolvedValueOnce(['a']);
        await expect(genie.storage.list('a')).resolves.toEqual(['a']);
        expect(fake.request).toHaveBeenLastCalledWith('app.storage.list', { prefix: 'a' });
    });

    it('a store that is full is a RefusedError in the store\'s words', async () => {
        const fake = fakeBridge();
        inWindow(fake.bridge);
        const genie = await connect();
        fake.request.mockRejectedValueOnce(new Error('notes\'s storage is full: an app keeps at most 50 MB. Nothing was saved.'));
        await expect(genie.storage.set('a', 1)).rejects.toMatchObject({ reason: expect.stringMatching(/storage is full/) });
    });

    it('on() hears the short names, after can() has moved, and stops when told', async () => {
        const fake = fakeBridge();
        inWindow(fake.bridge);
        const genie = await connect();
        const heard: boolean[] = [];
        const off = genie.on('grantChanged', () => heard.push(genie.can('checkIssues')));
        fake.fire('app.grantChanged', { granted: ['checkIssues'], scope: 'workstation' });
        expect(heard).toEqual([true]);
        off();
        fake.fire('app.grantChanged', { granted: [], scope: 'workstation' });
        expect(heard).toEqual([true]);
        const catalog = vi.fn();
        genie.on('catalogChanged', catalog);
        fake.fire('app.catalogChanged', { revision: 3, granted: [] });
        expect(catalog).toHaveBeenCalledWith({ revision: 3, granted: [] });
    });
});

describe('the generated types', () => {
    const FILE = join('packages', 'app-sdk', 'src', 'generated.ts');
    const defs = genieCatalog().list();

    it('the checked-in file is exactly what the generator writes now (after a schema change: npm run docs:sdk)', async () => {
        expect((await readFile(FILE, 'utf8')).replace(/\r\n/g, '\n'), `${FILE} is stale: run npm run docs:sdk`).toBe(renderAppSdkTypes(defs));
    });

    it('a changed tool schema changes what it writes, so a stale file cannot pass', () => {
        const changed = defs.map((d) => (d.id === 'knowledge' ? { ...d, payload: { ...d.payload, inputSchema: { type: 'object', properties: { only: { type: 'boolean' } }, required: ['only'] } } } : d));
        expect(renderAppSdkTypes(changed)).not.toBe(renderAppSdkTypes(defs));
        expect(renderAppSdkTypes(changed)).toContain('only: boolean');
    });

    it('holds the bridge as the catalog has it', () => {
        expect(BRIDGE_CALLS).toEqual(APP_BRIDGE.calls);
        expect(BRIDGE_EVENTS).toEqual(APP_BRIDGE.events);
    });

    it('offers what an app can be granted, and nothing an app never can be', () => {
        const text = renderAppSdkTypes(defs);
        expect(text).toMatch(/^ {4}knowledge: \{/m);
        expect(text).toContain("'ai.genie.spreadsheet.createWorkbook': {");
        for (const never of ['ForceTheQuestion', 'imDone', 'createAgent', 'lists', 'plan', 'flows', 'mail', 'thumbsUp']) expect(text, never).not.toMatch(new RegExp(`^ {4}${never}:`, 'm'));
    });

    it('never offers a terminal id; a required argument is required, an enum is its values', () => {
        const text = renderAppSdkTypes(defs);
        expect(text).not.toContain('terminalId');
        expect(text).toContain("action: 'search' | 'get' | 'add' | 'list' | 'link';");
        expect(text).toContain('limit?: number;');
        expect(text).toContain('tags?: string[];');
    });

    it('holds the `app` element\'s payload as the catalog\'s table says it', () => {
        const text = renderAppSdkTypes(defs);
        const app = KIND_SPECS.find((s) => s.kind === 'app')!;
        for (const field of app.fields) expect(text, field.name).toMatch(new RegExp(`^ {4}${field.name}\\??: `, 'm'));
        expect(text).toContain('entry: string;');
        expect(text).toContain("storage?: 'none' | 'app';");
        expect(text).toContain('uses?: string[];');
        expect(text).toContain('width?: number;');
    });
});

describe('the package', () => {
    it('is @genie/app-sdk, with no runtime dependencies', async () => {
        const pkg = JSON.parse(await readFile(join('packages', 'app-sdk', 'package.json'), 'utf8')) as Record<string, unknown>;
        expect(pkg.name).toBe('@genie/app-sdk');
        expect(pkg.dependencies).toBeUndefined();
        expect(pkg.files).toEqual(['dist']);
    });

    it('builds with its own config, and what it builds works', async () => {
        const out = await mkdtemp(join(tmpdir(), 'genie2-app-sdk-'));
        try {
            execFileSync(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', join('packages', 'app-sdk', 'tsconfig.json'), '--outDir', out], { stdio: 'pipe' });
            await writeFile(join(out, 'package.json'), '{"type":"module"}');
            const built = await import(pathToFileURL(join(out, 'index.js')).href) as { connect(): Promise<unknown>; NotInGenieError: new () => Error };
            await expect(built.connect()).rejects.toBeInstanceOf(built.NotInGenieError);
            expect(await readFile(join(out, 'index.d.ts'), 'utf8')).toContain('NotGrantedError');
        } finally {
            await rm(out, { recursive: true, force: true });
        }
    }, 60_000);
});

describe('npm run check:package', () => {
    const pair = generateKeyPairSync('ed25519');
    const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
    const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    let root: string;
    let lines: string[];
    const ports = (over: Partial<{ keys: Record<string, string> }> = {}) => ({ keys: over.keys ?? keys, catalog: () => genieCatalog(), write: (line: string) => { lines.push(line); } });

    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'genie2-check-package-')); lines = []; });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    async function fixture(over: { uses?: string[]; drop?: string; sign?: boolean } = {}): Promise<string> {
        const dir = join(root, 'pkg');
        await mkdir(join(dir, 'app'), { recursive: true });
        const manifest: Record<string, unknown> = {
            id: 'com.example.notes', name: 'Notes', version: '1.0.0', publisher: { name: 'Example Co', keyId: KEY_ID },
            contributions: [{
                id: 'com.example.notes.app', kind: 'app', docs: { name: 'Notes', description: 'Notes.' },
                reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
                permissions: { capabilities: [], network: ['api.example.com'] },
                payload: { entry: 'app/index.html', uses: over.uses ?? ['knowledge'] },
            }],
        };
        if (over.drop) delete manifest[over.drop];
        await writeFile(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify(manifest));
        await writeFile(join(dir, 'app', 'index.html'), '<!doctype html>');
        if (over.sign !== false) await signPackage(dir, pair.privateKey);
        return dir;
    }

    async function hostsReason(dir: string): Promise<string> {
        const book = await GAppBook.open({ dir: join(root, 'unused'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog() });
        const review = await book.reviewInstall(dir);
        if (review.ok) throw new Error('the host accepted it');
        return review.reason;
    }

    it('a good package passes and says what the person will be asked', async () => {
        const dir = await fixture();
        expect(await checkPackageCommand([dir], ports())).toBe(0);
        const text = lines.join('\n');
        expect(text).toMatch(/Notes 1\.0\.0 passes/);
        expect(text).toContain(genieCatalog().get('knowledge')!.docs.name);
        expect(text).toContain('api.example.com');
    });

    it.each([
        ['a manifest that names no publisher', { drop: 'publisher' }],
        ['an ungrantable element', { uses: ['ForceTheQuestion'] }],
        ['an unsigned package', { sign: false }],
    ])('%s: fails, printing the host\'s own reason', async (_name, over) => {
        const dir = await fixture(over);
        const reason = await hostsReason(dir);
        expect(await checkPackageCommand([dir], ports())).toBe(1);
        expect(lines.join('\n')).toContain(reason);
    });

    it('a file changed after signing fails with the host\'s reason', async () => {
        const dir = await fixture();
        await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><title>changed</title>');
        const reason = await hostsReason(dir);
        expect(await checkPackageCommand([dir], ports())).toBe(1);
        expect(lines.join('\n')).toContain(reason);
    });

    it('--publisher-checks-off passes an unsigned work in progress, as Unverified', async () => {
        const dir = await fixture({ sign: false });
        expect(await checkPackageCommand([dir, '--publisher-checks-off'], ports())).toBe(0);
        expect(lines.join('\n')).toMatch(/unverified/i);
    });

    it('no folder is a usage line and exit code 2', async () => {
        expect(await checkPackageCommand([], ports())).toBe(2);
        expect(lines.join('\n')).toMatch(/check:package -- <folder>/);
    });

    it('writes nothing into the package or anywhere it checks', async () => {
        const dir = await fixture();
        const before = await readFile(join(dir, PACKAGE_MANIFEST_FILE), 'utf8');
        await checkPackageCommand([dir], ports());
        expect(await readFile(join(dir, PACKAGE_MANIFEST_FILE), 'utf8')).toBe(before);
    });

    it('the real command prints the reason and exits 1', async () => {
        const dir = await fixture({ drop: 'publisher' });
        const reason = await hostsReason(dir);
        const run = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'check-package.ts'), dir], { encoding: 'utf8' });
        expect(run.stdout + run.stderr).toContain(reason);
        expect(run.status).toBe(1);
    }, 60_000);

    it('npm run check:package is that command', async () => {
        const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts['check:package']).toBe('tsx scripts/check-package.ts');
    });
});
