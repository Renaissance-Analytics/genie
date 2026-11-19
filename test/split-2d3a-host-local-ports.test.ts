import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatDraftStore } from '../src/main/chat-draft-store.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostLocalPorts, type HostLocalSources } from '../src/main/host-local-ports.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * CLIENT/HOST SPLIT STEP 2d-3a (Tynn #898, story #905): GENIE-HOST'S OWN LOCAL PORTS.
 *
 * The `local` families (the file panel, chat drafts, the ArtBoard, the window's own terminals, the Marketplace, GApps and
 * the Tynn tab's change reads) are what this machine's window asks of its host. Until now genie-host's answers had none of
 * them: the window's main process answered them, over parts it reached in genie-host through the engine link. genie-host
 * now answers them from what it owns, so that at 2d-4 the window can connect to genie-host's RemoteHost and be served there.
 *
 * Nothing gains a refusal (the owner, 2026-11-18). What only a window can do (an app's own window, a preview) is still
 * refused in words, as genie-host refused every GApp call before.
 */

let dir = '';
let registry: Registry;

function engine(): HostAloneEngine {
    return { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
}

function board() {
    return {
        signedIn: () => true,
        projectFor: (workspaceId: string) => (workspaceId === 'tynn' ? 'proj_1' : null),
        request: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    };
}

function ports(over: Record<string, unknown> = {}): HostAlonePorts {
    const e = engine();
    return {
        hostName: 'alphar', registry, engine: () => e, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => [], open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        terminals: { open: () => null, list: () => [], attach: () => null, write: () => true, resize: () => true, close: () => true, onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
        serviceEnvFor: () => ({}),
        uploads: { sendFile: async () => ({ ok: true, messageId: 'msg_1' }) },
        workspaceLifecycle: { terminals: () => null, supervisor: () => null, engines: () => null, reverifyTrust: async () => {}, github: () => null, tynn: () => null, defaultEnvFile: () => '', stagingDirectory: () => '' },
        colors: { set: async () => ({ ok: true }) },
        tynnTab: { board: async () => board(), readPage: async () => ({ ok: true }) },
        ...over,
    } as unknown as HostAlonePorts;
}

/** genie-host's own parts, as genie-host.ts hands them over; each records what reached it. */
function sources(over: Partial<HostLocalSources> = {}) {
    const calls: unknown[][] = [];
    const tynnPath = join(dir, 'tynn');
    const terminals = {
        openReady: async (options: unknown) => { calls.push(['openReady', options]); return { id: 't1', pid: 7, shell: 'bash' }; },
        lastCwd: () => '/last',
        write: () => true, resize: () => true, close: () => true,
        list: () => [{ id: 't1', pid: 7, shell: 'bash', workspaceId: 'tynn' }, { id: 't2', pid: 8, shell: 'bash', workspaceId: 'other' }],
        attach: (id: string) => (id === 't1' ? { id: 't1', pid: 7, shell: 'bash', workspaceId: 'tynn', scrollback: 'hi' } : null),
        streamSnapshot: () => ({ epoch: 'e1', endOffset: 2 }),
        onData: () => () => {}, onExit: () => () => {},
    };
    const book = { list: async () => [{ id: 'app1' }], review: async () => ({}), install: async () => ({}), setOn: async () => {}, uninstall: async () => {}, allowPreviewNetwork: async () => {} };
    const changed = new Set<() => void>();
    const marketplace = { search: async () => ({ packages: [], nextCursor: null }), prepare: async () => ({}), install: async () => ({ id: 'p', version: '1' }), discard: async () => {} };
    const s: HostLocalSources = {
        workspaces: () => [{ id: 'tynn', path: tynnPath }],
        files: () => ({ open: async (w: string, p: string) => { calls.push(['open', w, p]); return { ok: true, path: p, text: 'x', sha: 's' }; } }) as never,
        plugins: {
            dump: () => ({
                entries: [{ id: 'sheets', state: 'enabled' }, { id: 'off', state: 'disabled' }],
                panels: [], editors: [],
                manifests: {
                    sheets: { id: 'sheets', editors: [{ id: 'e', title: 'E', extensions: ['.xyz'] }], capabilities: { fs: { extensions: ['.xyz'] } } },
                    off: { id: 'off', editors: [{ id: 'e', title: 'E', extensions: ['.xyz'] }], capabilities: { fs: { extensions: ['.xyz'] } } },
                },
            }) as never,
        },
        sendFromPerson: async (agentId, text) => { calls.push(['send', agentId, text]); },
        drafts: null as never,
        terminals: () => terminals as never,
        trackCwd: () => true,
        terminalEnv: (workspaceId) => ({ GENIE_MCP_URL: `http://mcp/${workspaceId}` }),
        marketplace: () => marketplace,
        gapps: () => book as never,
        onGappsChanged: (listener) => { changed.add(listener); return () => { changed.delete(listener); }; },
        say: () => {},
        ...over,
    };
    return { s, calls, terminals, book, changed, marketplace };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d3a-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await mkdir(join(dir, 'tynn'));
    await writeFile(join(dir, 'tynn', 'project.json'), JSON.stringify({ name: 'tynn' }));
    await registry.addWorkspace({ id: 'tynn', path: join(dir, 'tynn') });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('genie-host answers the local families itself', () => {
    it('the file panel, drafts, ArtBoard and the window\'s terminals reach genie-host\'s own ports', async () => {
        const reached: string[] = [];
        const alone = hostAloneApi(ports({
            local: {
                localFiles: { files: () => ({ open: async () => { reached.push('files'); return { ok: true, path: 'a', text: '', sha: '' }; } }), editor: () => null, repo: async () => { reached.push('repo'); return { ok: true }; } },
                chatDrafts: { all: () => { reached.push('drafts'); return {}; }, save: async () => {}, putFile: async () => 'r', readFile: async () => null, release: async () => {} },
                artboard: { read: async () => { reached.push('artboard'); return { posts: [] }; }, review: async () => ({ ok: true }) },
                localTerminals: { invoke: async (name: string) => { reached.push(`terminals.${name}`); return []; }, snapshot: async () => null },
            },
        }));
        await alone.invoke('files.localOpen', ['tynn', 'a.txt']);
        await alone.invoke('repo.call', ['status', 'tynn', '']);
        await alone.invoke('chatDrafts.load', []);
        await alone.invoke('artboard.read', ['tynn']);
        await alone.invoke('terminals.localList', ['tynn']);
        expect(reached).toEqual(['files', 'repo', 'drafts', 'artboard', 'terminals.list']);
    });

    it('the Tynn tab\'s change reads are genie-host\'s Tynn account\'s: a linked workspace is read, an unlinked one is said', async () => {
        const alone = hostAloneApi(ports());
        const linked = await alone.invoke('workspaces.tynnBoardChanges', ['tynn', {}, 'c1', []]) as { ok: boolean };
        const issues = await alone.invoke('workspaces.tynnIssueChanges', ['tynn', {}, 'c1', []]) as { ok: boolean };
        const unlinked = await alone.invoke('workspaces.tynnBoardChanges', ['nope', {}, 'c1', []]) as { ok: boolean; reason?: string };
        for (const answer of [linked, issues]) expect(JSON.stringify(answer)).not.toMatch(/open Genie on/);
        expect(unlinked.ok).toBe(false);
        expect(JSON.stringify(unlinked)).not.toMatch(/open Genie on/);
    });

    it('the ports RemoteHost reads off the API are genie-host\'s, once its answers are built', () => {
        const { s, marketplace } = sources();
        let built: HostApi | null = null;
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, alone: () => built });
        expect(api.marketplace?.() ?? null).toBeNull();
        built = hostAloneApi(ports({ local: hostLocalPorts(s) }));
        expect(api.marketplace?.()).toBe(marketplace);
        expect(api.gapps?.()).not.toBeNull();
        expect(api.localTerminals).toBe(built.localTerminals);
        expect(api.localAgents).toBe(built.localAgents);
    });

    it('CONTROL, moves at 2d-3b: the owner operations are not genie-host\'s yet', async () => {
        await expect(hostRemoteApi({ hostName: 'alphar', own: {}, alone: hostAloneApi(ports()) }).invoke('appInbox.state', ['tynn'])).rejects.toThrow('open Genie on alphar');
    });
});

describe('genie-host\'s local ports, from what it owns', () => {
    it('the editor gate is its own plugins\': an enabled plugin\'s claimed type only', () => {
        const editor = hostLocalPorts(sources().s).localFiles!.editor()!;
        expect(editor.gate('sheets', 'a/b.xyz')).toEqual({ allowed: true });
        expect(editor.gate('off', 'a/b.xyz').allowed).toBe(false);
        expect(editor.gate('sheets', 'a/b.txt').allowed).toBe(false);
    });

    it('a file opens through its files host', async () => {
        const { s, calls } = sources();
        await hostLocalPorts(s).localFiles!.files()!.open('tynn', 'a.txt');
        expect(calls).toContainEqual(['open', 'tynn', 'a.txt']);
    });

    it('the ArtBoard reads the workspace\'s folder here; an unknown workspace is said', async () => {
        const art = hostLocalPorts(sources().s).artboard!;
        expect((await art.read('tynn')).error).toBeUndefined();
        expect((await art.read('nope')).error).toBeTruthy();
    });

    it('a draft\'s file is read as a stream from its draft store', async () => {
        const drafts = await ChatDraftStore.open(dir);
        const port = hostLocalPorts(sources({ drafts }).s).chatDrafts!;
        const ref = await port.putFile(new Uint8Array([1, 2, 3]));
        const read = await port.readFile(ref);
        expect(read).not.toBeNull();
        expect(read instanceof Uint8Array).toBe(false);
    });

    it('a terminal opens in its workspace with the shells\' environment, where the last one was', async () => {
        const { s, calls } = sources();
        await hostLocalPorts(s).localTerminals!.invoke('open', ['tynn', { cols: 80, rows: 24 }]);
        expect(calls).toContainEqual(['openReady', { workspaceId: 'tynn', cwd: '/last', command: undefined, cols: 80, rows: 24, personal: true, env: { GENIE_MCP_URL: 'http://mcp/tynn' } }]);
        const off = sources({ trackCwd: () => false });
        await hostLocalPorts(off.s).localTerminals!.invoke('open', ['tynn', {}]);
        expect((off.calls[0]![1] as { cwd: string }).cwd).toBe(join(dir, 'tynn'));
    });

    it('a terminal is listed and joined in its own workspace only', async () => {
        const port = hostLocalPorts(sources().s).localTerminals!;
        expect(await port.invoke('list', ['tynn'])).toEqual([{ id: 't1', pid: 7, shell: 'bash' }]);
        expect(await port.snapshot('tynn', 't1')).toEqual({ value: { id: 't1', pid: 7, shell: 'bash', scrollback: 'hi' }, position: expect.anything() });
        expect(await port.snapshot('other', 't1')).toBeNull();
    });

    it('the Marketplace and the GApp book are its own; an app\'s window is a window\'s to open, said in words', async () => {
        const { s, marketplace, changed } = sources();
        const local = hostLocalPorts(s);
        expect(local.marketplace!()).toBe(marketplace);
        const gapps = local.gapps!()!;
        expect(await gapps.list()).toEqual([{ id: 'app1' }]);
        await expect(gapps.open('app1')).rejects.toThrow(/Genie window/);
        await expect(gapps.preview('app1')).rejects.toThrow(/Genie window/);
        const off = gapps.onChanged(() => {});
        expect(changed.size).toBe(1);
        off();
        expect(changed.size).toBe(0);
        expect(hostLocalPorts(sources({ gapps: () => null }).s).gapps!()).toBeNull();
    });
});

describe('the wiring', () => {
    it('genie-host hands its own local ports to its answers', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/local: hostLocalPorts\(/);
    });

    it('main and genie-host decide an editor\'s file access with the same code', () => {
        for (const file of ['src/main/plugins-replica.ts', 'src/main/host-local-ports.ts']) expect(readFileSync(file, 'utf8'), file).toContain('editorBytesOfDump(');
    });
});
