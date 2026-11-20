import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { IPC_INVENTORY, WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { LOCAL_FRAME_CHANNELS } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, WORKSPACE_SCOPED_METHODS, capabilityOf, inMemoryPair, parseMessage, type CallContext, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { isRemoteQuestionId, REMOTE_QUESTION_PREFIX } from '../src/core/remote-question-id.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { hostQuestionReads } from '../src/main/host-question-reads.js';
import { hostShellFor } from '../src/main/host-shell.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { actOnRemoteQuestion } from '../src/main/remote-questions.js';
import { windowOpsHandler } from '../src/main/window-tunnel.js';
import { questionBridge, type QuestionProtocol } from '../src/renderer/question-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2f-1 (Tynn #898, story #912; the coordinator's plan and rulings of 2026-11-19). A client is a dumb
 * terminal: the ForceTheQuestion window keeps only its window (what to show, Later, the queue pick, the draft, the drawer's
 * width, Open in Files) and reaches the host over the one protocol for the rest:
 *  - an answer and a Dismiss are `features.act` (the Deck's own action), over the window's own frame port;
 *  - a question's named files and its ArtBoard visuals are `questions.files` / `questions.file` / `questions.visuals`,
 *    answered by genie-host from ITS OWN Deck and the question's workspace, for every client;
 *  - another machine's question (Tynn #726) goes back through the window that drives that machine, which holds THAT host's
 *    protocol connection (`question:remote`): window to window, never this host's.
 * Open with the host's app and Show in its file manager, for a client on ANOTHER machine, are `files.openExternal` /
 * `files.reveal`: the host opens it on its own screen (a window there does it, like the trash). This machine's own window
 * keeps the OS shell (window:os-shell). host-wait:act is re-labelled window:host-wait (the coordinator, 2026-11-19).
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const OWNER: CallContext = { connectionId: 'rc_1', origin: 'remote-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop' };
const LOCAL: CallContext = { connectionId: 'lc_1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'this Genie window' };
const GUEST_B: CallContext = { ...OWNER, connectionId: 'rc_2', isOwner: false, workspaceId: 'ws_b', label: 'guest' };

const question = (id: string, workspaceId: string | null, extra: Partial<DeckItem> = {}): DeckItem => ({
    id, source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId, title: 'Pick', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', questions: [{ header: 'Pick', question: 'See notes.md — which?', options: [{ label: 'A' }, { label: 'B' }] }] }, forwardedFrom: null, ...extra,
} as DeckItem);

describe('the protocol: the question window’s reads and the host’s shell are methods every client may ask', () => {
    it('questions.files / file / visuals are reads; files.openExternal / reveal are workspace-scoped writes; genie-host answers all five', () => {
        for (const m of ['questions.files', 'questions.file', 'questions.visuals']) {
            expect(REMOTE_METHODS as readonly string[], m).toContain(m);
            expect(capabilityOf(m as RemoteMethod), m).toBe('read');
            expect(HOST_ALONE_METHODS.has(m as RemoteMethod), m).toBe(true);
        }
        for (const m of ['files.openExternal', 'files.reveal']) {
            expect(REMOTE_METHODS as readonly string[], m).toContain(m);
            expect(capabilityOf(m as RemoteMethod), m).toBe('write');
            expect(WORKSPACE_SCOPED_METHODS as readonly string[], m).toContain(m);
            expect(HOST_ALONE_METHODS.has(m as RemoteMethod), m).toBe(true);
        }
    });

    it('engine.featureQuestion is retired: no engine method, no route in the engine server, no call from main', () => {
        expect(ENGINE_METHODS as readonly string[]).not.toContain('engine.featureQuestion');
        expect(code(src('src/main/session-engine-server.ts'))).not.toContain('engine.featureQuestion');
        expect(code(src('src/main/main.ts'))).not.toContain('engine.featureQuestion');
    });
});

describe('genie-host reads a question’s files and visuals from ITS deck and the question’s workspace', () => {
    let dir = '';
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-2f-'));
        await writeFile(join(dir, 'notes.md'), 'the notes');
        await mkdir(join(dir, 'sub'));
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const reads = () => hostQuestionReads({
        deck: () => [question('q_1', 'ws_a'), question('q_os', null), { ...question('n_1', 'ws_a'), source: 'notice' } as unknown as DeckItem],
        workspacePath: (id) => (id === 'ws_a' ? dir : null),
    });

    it('files: which named files are there, inside the question’s workspace only (at most 16 looked at)', async () => {
        expect(await reads().files('q_1', ['notes.md', 'missing.md', '../outside.md', 42 as unknown as string], OWNER)).toEqual(['notes.md']);
    });

    it('file: one file’s text, confined to the question’s workspace', async () => {
        expect(await reads().file('q_1', 'notes.md', OWNER)).toMatchObject({ ok: true, text: 'the notes' });
        expect(await reads().file('q_1', '../x.md', OWNER)).toEqual({ ok: false, reason: 'that file is not in this workspace' });
    });

    it('visuals: its ArtBoard posts (none named, none read)', async () => {
        expect(await reads().visuals('q_1', OWNER)).toEqual({ ok: true, posts: [] });
    });

    it('a question the host does not hold, one with no workspace, and an item that is not a question: nothing read', async () => {
        const r = reads();
        expect(await r.files('q_gone', ['notes.md'], OWNER)).toBeNull();
        expect(await r.files('q_os', ['notes.md'], OWNER)).toBeNull();
        expect(await r.files('n_1', ['notes.md'], OWNER)).toBeNull();
        expect(await r.file('q_gone', 'notes.md', OWNER)).toEqual({ ok: false, reason: 'Genie does not know this question’s workspace' });
        expect(await r.visuals('q_gone', OWNER)).toEqual({ ok: false, reason: 'Genie does not know this question' });
    });

    it('a guest of ANOTHER workspace is told nothing of this one’s question; the local window and the owner elsewhere are', async () => {
        const r = reads();
        expect(await r.files('q_1', ['notes.md'], GUEST_B)).toBeNull();
        expect(await r.file('q_1', 'notes.md', GUEST_B)).toEqual({ ok: false, reason: 'Genie does not know this question’s workspace' });
        expect(await r.visuals('q_1', GUEST_B)).toEqual({ ok: false, reason: 'Genie does not know this question' });
        expect(await r.files('q_1', ['notes.md'], LOCAL)).toEqual(['notes.md']);
        expect(await r.files('q_1', ['notes.md'], { ...GUEST_B, workspaceId: 'ws_a' })).toEqual(['notes.md']);
    });

    it('the host API answers the three from its question reads; with none, in words', async () => {
        const asked: unknown[][] = [];
        const questions = {
            files: async (...a: unknown[]) => { asked.push(['files', ...a]); return ['notes.md']; },
            file: async (...a: unknown[]) => { asked.push(['file', ...a]); return { ok: true, path: 'notes.md', text: 'x' }; },
            visuals: async (...a: unknown[]) => { asked.push(['visuals', ...a]); return { ok: true, posts: [] }; },
        };
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, questions } as unknown as HostApiDeps);
        expect(await api.invoke('questions.files' as RemoteMethod, ['q_1', ['notes.md', 7]], OWNER)).toEqual(['notes.md']);
        expect(await api.invoke('questions.file' as RemoteMethod, ['q_1', 'notes.md'], OWNER)).toMatchObject({ ok: true });
        expect(await api.invoke('questions.visuals' as RemoteMethod, ['q_1'], OWNER)).toEqual({ ok: true, posts: [] });
        expect(asked).toEqual([['files', 'q_1', ['notes.md'], OWNER], ['file', 'q_1', 'notes.md', OWNER], ['visuals', 'q_1', OWNER]]);
        const none = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await none.invoke('questions.files' as RemoteMethod, ['q_1', []], OWNER)).toBeNull();
        expect(await none.invoke('questions.visuals' as RemoteMethod, ['q_1'], OWNER)).toEqual({ ok: false, reason: 'this host cannot read a question’s visuals' });
    });

    it('genie-host composes them over its own deck and registry', () => {
        expect(code(src('src/main/genie-host.ts'))).toMatch(/questions: hostQuestionReads\(\{ deck: featureDeckItems, workspacePath: \(id\) => hostRegistry\.workspace\(id\)\?\.path \?\? null \}\)/);
    });
});

describe('this machine’s window and another machine’s client get the same answer over the wire', () => {
    async function connect(preAuth: Record<string, unknown>) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2f-wire-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const questions = { files: async () => ['notes.md'], file: async () => ({ ok: true, path: 'notes.md', text: 'the notes' }), visuals: async () => ({ ok: true, posts: [] }) };
        const inner = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, questions } as unknown as HostApiDeps);
        const api: HostApi = { invoke: (m: RemoteMethod, a: unknown[], ctx?: CallContext) => inner.invoke(m, a, ctx), onEvent: () => () => {}, workspaceOfAgent: () => 'ws_a' } as unknown as HostApi;
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (l) => { accept = l; return () => {}; } } });
        const pair = inMemoryPair();
        const frames: WireMessage[] = [];
        pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
        accept({ ...pair.server, preAuth: preAuth as never });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: preAuth.kind }, label: 'x' }));
        await settle();
        let id = 0;
        const call = async (method: string, args: unknown[]) => { id += 1; pair.client.send(JSON.stringify({ kind: 'call', id, method, args })); await settle(); return frames.find((m) => m.kind === 'result' && m.id === id); };
        const done = async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); };
        return { call, done };
    }

    it('questions.files / file / visuals: the local window and the owner on another machine read the same', async () => {
        const local = await connect({ kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' });
        const remote = await connect({ kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false });
        try {
            for (const [m, a] of [['questions.files', ['q_1', ['notes.md']]], ['questions.file', ['q_1', 'notes.md']], ['questions.visuals', ['q_1']]] as const) {
                const here = await local.call(m, [...a]);
                const there = await remote.call(m, [...a]);
                expect(here, m).toMatchObject({ kind: 'result', ok: true });
                expect((there as { value?: unknown }).value, m).toEqual((here as { value?: unknown }).value);
            }
        } finally { await local.done(); await remote.done(); }
    });
});

describe('the question page: an answer and a Dismiss over the protocol, another machine’s through its window', () => {
    type Act = { kind: string; item?: unknown; selections?: unknown; notes?: unknown; note?: unknown };
    function fakeProtocol() {
        const acts: Act[] = [];
        const reads: unknown[][] = [];
        let opened = 0;
        let closed = 0;
        const connect = (): QuestionProtocol => {
            opened += 1;
            return {
                ready: Promise.resolve({ ok: true }),
                bridge: {
                    features: { act: async (a: Act) => { acts.push(a); return {} as never; } },
                    questions: {
                        files: async (...a: unknown[]) => { reads.push(['files', ...a]); return ['notes.md']; },
                        file: async (...a: unknown[]) => { reads.push(['file', ...a]); return { ok: true as const, path: 'notes.md', text: 'x' }; },
                        visuals: async (...a: unknown[]) => { reads.push(['visuals', ...a]); return { ok: true as const, posts: [] }; },
                    },
                },
                close: () => { closed += 1; },
            } as unknown as QuestionProtocol;
        };
        return { acts, reads, connect, opened: () => opened, closed: () => closed };
    }
    const remoteId = `${REMOTE_QUESTION_PREFIX}7:q_far`;
    const view = { item: question('q_1', 'ws_a', { revision: 3 }), waiting: 1, queue: [question('q_1', 'ws_a', { revision: 3 }), question(remoteId, 'ws_far')] };
    function fakePreload() {
        const remote: unknown[] = [];
        return {
            remote,
            preload: {
                current: async () => view, later: async () => {}, onShow: () => () => {},
                remote: async (request: unknown) => { remote.push(request); return (request as { kind: string }).kind === 'visuals' ? { ok: true, posts: [{ id: 'p' }] } : { ok: true }; },
            },
        };
    }

    it('this machine’s question: features.act with the Deck’s own action (its id and revision, the picks, the notes); nothing through main', async () => {
        const p = fakeProtocol();
        const pre = fakePreload();
        const bridge = questionBridge(pre.preload as never, p.connect);
        await bridge.current();
        expect(await bridge.answer([['A']], ['ship it'], 'q_1')).toEqual({ ok: true });
        expect(await bridge.dismiss(['not now'], 'q_1')).toEqual({ ok: true });
        expect(p.acts).toEqual([
            { kind: 'deck.answerForm', item: { id: 'q_1', revision: 3 }, selections: [['A']], notes: ['ship it'], note: '' },
            // A Dismiss carries the item as the Deck's own Dismiss does (feature-deck.ts checks it is an agent's question).
            { kind: 'deck.dismiss', item: question('q_1', 'ws_a', { revision: 3 }), notes: ['not now'] },
        ]);
        expect(pre.remote).toEqual([]);
    });

    it('another machine’s question: through the window driving it (question:remote), never this host', async () => {
        const p = fakeProtocol();
        const pre = fakePreload();
        const bridge = questionBridge(pre.preload as never, p.connect);
        await bridge.current();
        expect(await bridge.answer([['B']], [''], remoteId)).toEqual({ ok: true });
        expect(await bridge.dismiss(['later'], remoteId)).toEqual({ ok: true });
        expect(await bridge.visuals!(remoteId)).toEqual({ ok: true, posts: [{ id: 'p' }] });
        expect(await bridge.files!(remoteId, ['notes.md'])).toBeNull();
        expect(pre.remote).toEqual([
            { kind: 'answer', id: remoteId, selections: [['B']], notes: [''] },
            { kind: 'dismiss', id: remoteId, notes: ['later'] },
            { kind: 'visuals', id: remoteId },
        ]);
        expect({ acts: p.acts, reads: p.reads, opened: p.opened() }).toEqual({ acts: [], reads: [], opened: 0 });
    });

    it('this machine’s reads go over the protocol: questions.files / file / visuals', async () => {
        const p = fakeProtocol();
        const bridge = questionBridge(fakePreload().preload as never, p.connect);
        expect(await bridge.files!('q_1', ['notes.md'])).toEqual(['notes.md']);
        expect(await bridge.file!('q_1', 'notes.md')).toMatchObject({ ok: true });
        expect(await bridge.visuals!('q_1')).toEqual({ ok: true, posts: [] });
        expect(p.reads).toEqual([['files', 'q_1', ['notes.md']], ['file', 'q_1', 'notes.md'], ['visuals', 'q_1']]);
    });

    it('ONE connection for calls in flight together (the door keeps one per window), closed once idle', async () => {
        vi.useFakeTimers();
        try {
            const p = fakeProtocol();
            const bridge = questionBridge(fakePreload().preload as never, p.connect, { idleMs: 1000 });
            await Promise.all([bridge.files!('q_1', ['notes.md']), bridge.visuals!('q_1')]);
            expect(p.opened()).toBe(1);
            expect(p.closed()).toBe(0);
            await vi.advanceTimersByTimeAsync(1000);
            expect(p.closed()).toBe(1);
            await bridge.visuals!('q_1');
            expect(p.opened()).toBe(2);
        } finally { vi.useRealTimers(); }
    });

    it('a host that refuses, or a link that never came up, is said beside the button, never swallowed', async () => {
        const refusing = (): QuestionProtocol => ({ ready: Promise.resolve({ ok: false, reason: 'Genie is still starting' }), bridge: {} as never, close: () => {} } as unknown as QuestionProtocol);
        const bridge = questionBridge(fakePreload().preload as never, refusing);
        await bridge.current();
        expect(await bridge.answer([['A']], [''], 'q_1')).toEqual({ ok: false, reason: 'Genie is still starting' });
    });

    it('the page builds its bridge from the preload and its own frame port', () => {
        expect(code(src('src/renderer/question-main.tsx'))).toMatch(/questionBridge\(window\.genieQuestion, \(\) => connectRemote\(localTransport\(window\.genieLocalProtocol!\), \{ kind: 'local' \}, 'the question window'\)\)/);
    });

    it('the remote id is the one RemoteQuestions mints', () => {
        expect(isRemoteQuestionId(remoteId)).toBe(true);
        expect(isRemoteQuestionId('q_1')).toBe(false);
        expect(src('src/main/remote-questions.ts')).toMatch(/const PREFIX = REMOTE_QUESTION_PREFIX;/);
    });
});

describe('question:remote: only another machine’s question, through the window driving it', () => {
    function ports() {
        const calls: unknown[][] = [];
        return {
            calls,
            ports: {
                owns: (id: string) => id.startsWith('remote:'),
                answer: async (...a: unknown[]) => { calls.push(['answer', ...a]); return { ok: true as const }; },
                dismiss: async (...a: unknown[]) => { calls.push(['dismiss', ...a]); return { ok: true as const }; },
                visuals: async (...a: unknown[]) => { calls.push(['visuals', ...a]); return { posts: [{ id: 'p' }] }; },
            },
        };
    }

    it('answers, dismisses and reads the visuals of another machine’s question', async () => {
        const p = ports();
        expect(await actOnRemoteQuestion({ kind: 'answer', id: 'remote:7:q', selections: [['A'], 3], notes: ['n', 4] }, p.ports)).toEqual({ ok: true });
        expect(await actOnRemoteQuestion({ kind: 'dismiss', id: 'remote:7:q', notes: ['x'] }, p.ports)).toEqual({ ok: true });
        expect(await actOnRemoteQuestion({ kind: 'visuals', id: 'remote:7:q' }, p.ports)).toEqual({ ok: true, posts: [{ id: 'p' }] });
        expect(p.calls).toEqual([['answer', [['A'], []], ['n', ''], 'remote:7:q'], ['dismiss', ['x'], 'remote:7:q'], ['visuals', 'remote:7:q']]);
    });

    it('this machine’s question is refused here: it is answered over the protocol', async () => {
        const p = ports();
        expect(await actOnRemoteQuestion({ kind: 'answer', id: 'q_1', selections: [], notes: [] }, p.ports)).toEqual({ ok: false, reason: 'this question is answered over Genie’s protocol, not through another machine’s window' });
        expect(await actOnRemoteQuestion({ kind: 'nonsense', id: 'remote:7:q' }, p.ports)).toEqual({ ok: false, reason: 'not a question action' });
        expect(p.calls).toEqual([]);
    });

    it('main wires it to the controller and RemoteQuestions', () => {
        const electron = code(src('src/main/question-window-electron.ts'));
        expect(electron).toMatch(/ipcMain\.handle\('question:remote', \(_e, raw: unknown\) =>/);
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/admit: \(contents\) => \{ localDoor\.admit\(contents\); \}/);
    });
});

describe('the window no longer reaches the host off the one protocol', () => {
    const GONE = ['question:answer', 'question:dismiss', 'question:files', 'question:file', 'question:visuals'];

    it('the preload invokes none of the five; main registers none; the rows leave both lists', () => {
        const preload = code(src('src/main/question-preload.ts'));
        const electron = code(src('src/main/question-window-electron.ts'));
        for (const channel of GONE) {
            expect(preload, channel).not.toContain(`'${channel}'`);
            expect(electron, channel).not.toContain(`'${channel}'`);
            expect(IPC_INVENTORY.map(([c]) => c), channel).not.toContain(channel);
            expect(src('test/ipc-inventory.test.ts'), channel).not.toMatch(new RegExp(`'${channel}': '2f'`));
        }
        expect(IPC_INVENTORY).toContainEqual(['question:remote', 'window:pop-out']);
        expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u)).not.toContain('call:engine.featureQuestion');
        expect(src('test/split-2e-window-guard.test.ts')).not.toMatch(/'call:engine\.featureQuestion': '2f'/);
    });

    it('the question preload carries the one frame port, its channels written out equal to LOCAL_FRAME_CHANNELS', () => {
        const preload = src('src/main/question-preload.ts');
        expect(preload).toContain(`exposeInMainWorld('genieLocalProtocol'`);
        expect(preload).toContain(`ipcRenderer.send('${LOCAL_FRAME_CHANNELS.toHost}', action, connection, text)`);
        expect(preload).toContain(`ipcRenderer.on('${LOCAL_FRAME_CHANNELS.toWindow}', onFrame)`);
        // A module two sandboxed preloads share becomes a chunk neither can require: the strings, never the import.
        expect(preload).not.toMatch(/from '\.\.\/core\/local-frame\.js'/);
    });
});

describe('Open with / Show in file manager for a client on ANOTHER machine: on the host’s own screen', () => {
    function shell(windowOp: (op: string, args: unknown[]) => Promise<unknown>) {
        return hostShellFor({ absolute: (ws, path) => (ws === 'ws_a' && path === 'a.txt' ? '/w/a/a.txt' : null), windowOp, hostName: () => 'alphar' });
    }

    it('the host confines the path, then a window on its own machine opens it, or shows it in its file manager', async () => {
        const asked: unknown[][] = [];
        const s = shell(async (op, args) => { asked.push([op, args]); return op === 'shell.open' ? '' : true; });
        expect(await s.open('ws_a', 'a.txt')).toEqual({ ok: true });
        expect(await s.reveal('ws_a', 'a.txt')).toEqual({ ok: true });
        expect(asked).toEqual([['shell.open', ['/w/a/a.txt']], ['shell.reveal', ['/w/a/a.txt']]]);
    });

    it('outside the workspace: nothing asked; the OS refusing, and no window on the host, are said in words', async () => {
        const asked: unknown[] = [];
        expect(await shell(async (op) => { asked.push(op); return ''; }).open('ws_a', '../x')).toEqual({ ok: false, reason: 'that file is not in this workspace' });
        expect(asked).toEqual([]);
        expect(await shell(async () => 'no app for .xyz').open('ws_a', 'a.txt')).toEqual({ ok: false, reason: 'no app for .xyz' });
        expect(await shell(async () => { throw new Error('no Genie window is open on this machine'); }).reveal('ws_a', 'a.txt'))
            .toEqual({ ok: false, reason: 'alphar has no Genie window open to show it on' });
    });

    it('the window op: confined to this machine’s workspaces again, whoever asked', async () => {
        const opened: string[] = [];
        const revealed: string[] = [];
        const ops = windowOpsHandler({ trash: async () => {}, workspaces: () => [{ path: resolve('/w/a') }], openApp: async () => {}, openTerminalWindow: async () => 'closed',
            openPath: async (p) => { opened.push(p); return ''; }, reveal: (p) => { revealed.push(p); } });
        expect(await ops('shell.open', [resolve('/w/a/a.txt')])).toBe('');
        expect(await ops('shell.reveal', [resolve('/w/a/a.txt')])).toBe(true);
        await expect(ops('shell.open', [resolve('/elsewhere/x')])).rejects.toThrow(/inside one of this machine’s workspaces/);
        expect({ opened, revealed }).toEqual({ opened: [resolve('/w/a/a.txt')], revealed: [resolve('/w/a/a.txt')] });
    });

    it('the host API: files.openExternal and files.reveal go to the host’s shell; with none, in words', async () => {
        const asked: unknown[][] = [];
        const hostShell = { open: async (...a: unknown[]) => { asked.push(['open', ...a]); return { ok: true }; }, reveal: async (...a: unknown[]) => { asked.push(['reveal', ...a]); return { ok: true }; } };
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, hostShell } as unknown as HostApiDeps);
        expect(await api.invoke('files.openExternal' as RemoteMethod, ['ws_a', 'a.txt'], OWNER)).toEqual({ ok: true });
        expect(await api.invoke('files.reveal' as RemoteMethod, ['ws_a', 'a.txt'], OWNER)).toEqual({ ok: true });
        expect(asked).toEqual([['open', 'ws_a', 'a.txt'], ['reveal', 'ws_a', 'a.txt']]);
        const none = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await none.invoke('files.openExternal' as RemoteMethod, ['ws_a', 'a.txt'], OWNER)).toEqual({ ok: false, reason: 'this host cannot open files on its screen' });
    });

    it('wired: genie-host over its files and the window op; main’s windowOps over Electron’s shell; the wire bridge asks the host', () => {
        expect(code(src('src/main/genie-host.ts'))).toMatch(/hostShell: hostShellFor\(\{ absolute: \(ws, path\) => phoneFiles\.absolute\(ws, path\), windowOp: \(op, args\) => \(engineRef \? engineRef\.windowOp\(null, op, args\)/);
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/openPath: \(absolutePath\) => shell\.openPath\(absolutePath\)/);
        expect(main).toMatch(/reveal: \(absolutePath\) => \{ shell\.showItemInFolder\(absolutePath\); \}/);
        const wire = code(src('src/renderer/remote-bridge.ts'));
        expect(wire).toMatch(/openExternal: \(workspaceId, path\) => answer<[^>]+>\('files\.openExternal', workspaceId, path\)/);
        expect(wire).toMatch(/reveal: \(workspaceId, path\) => answer<[^>]+>\('files\.reveal', workspaceId, path\)/);
    });

    it('CONTROL: this machine’s own window keeps the OS shell (window:os-shell)', () => {
        expect(IPC_INVENTORY).toContainEqual(['genie:files-open-external', 'window:os-shell']);
        expect(IPC_INVENTORY).toContainEqual(['genie:files-reveal', 'window:os-shell']);
    });
});

describe('host-wait:act is the host-wait window’s own (the coordinator, 2026-11-19)', () => {
    it('re-labelled window:host-wait, off the still-to-move list', () => {
        expect(IPC_INVENTORY).toContainEqual(['host-wait:act', 'window:host-wait']);
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'host-wait:act': '2f'/);
    });

    it('GUARD: registered only while the engine link is down: before the link is made, and removed the moment it is', () => {
        const main = code(src('src/main/main.ts'));
        const registrations = [...main.matchAll(/ipcMain\.handle\('host-wait:act'/g)].map((m) => m.index!);
        expect(registrations).toHaveLength(1);
        const link = main.indexOf('agentEngineLink = await connectAgentEngine(');
        const done = main.indexOf('hostWait.done();', link);
        const removed = main.indexOf("ipcMain.removeHandler('host-wait:act');", link);
        expect(link).toBeGreaterThan(registrations[0]!);
        expect(done).toBeGreaterThan(link);
        // Nothing runs between the link coming back and the handler going: the removal follows hostWait.done() directly.
        expect(main.slice(done, removed).replace(/\s+/g, ' ')).toBe("hostWait.done(); ipcMain.removeHandler('host-wait:current'); ");
        // Nowhere else under src/main registers it.
        for (const file of ['src/main/genie-host.ts', 'src/main/host-wait-window.ts', 'src/main/question-window-electron.ts']) expect(code(src(file)), file).not.toMatch(/ipcMain\.handle\('host-wait:act'/);
    });

    it('CONTROL: the guard notices a registration after the link', () => {
        const moved = "x; agentEngineLink = await connectAgentEngine(); hostWait.done(); ipcMain.removeHandler('host-wait:current'); ipcMain.removeHandler('host-wait:act'); ipcMain.handle('host-wait:act', f);";
        expect([...moved.matchAll(/ipcMain\.handle\('host-wait:act'/g)].map((m) => m.index!)[0]).toBeGreaterThan(moved.indexOf('agentEngineLink = await connectAgentEngine('));
    });
});
