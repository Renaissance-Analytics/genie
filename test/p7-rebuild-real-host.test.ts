import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { TYNN_HOST } from '../src/core/tynn.js';
import { connectSocket } from '../src/main/engine-launch.js';
import { classifyDataPath } from '../src/main/data-root.js';
import { openSecretKeychain } from '../src/main/file-secrets.js';
import { restrictPrivateFile } from '../src/main/private-credentials.js';
import { flowFormDefaults } from '../src/core/forms.js';
import { ownProtocolClient, type OwnCallAnswer, type OwnProtocolClient } from '../src/main/own-protocol-client.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { tunnelDoor, tunnelLinkOf } from '../src/main/window-tunnel.js';
import type { FeatureData } from '../src/renderer/features.js';
import { PAIRING_SCOPES } from './helpers/tynn-storage.js';

const TSX = import.meta.resolve('tsx');

/**
 * P7.3 — THE UNIT "REBUILD" (`.ai/plans/genie-2-host-split-2026-10-31.md`, "P7 build spec: one data root", Red first; Tynn #419).
 *
 * A real genie-host lives on a root: two agents with their threads, mail waiting, a flow, a workstation on record, a
 * paired machine, sign-ins. It is stopped. ONLY THE STATE LIST of its own manifest is copied into a fresh root — what a
 * rebuilt machine is given back — and the same build is started there, as its own process:
 *
 *  - every agent, thread, inbox message and flow is back, as the host itself answers them;
 *  - every machine file a host makes at start is made again, and nothing of the old machine's came along;
 *  - it SAYS what it could not restore: each secret the root points at and the keychain no longer holds is on its Deck
 *    with its action.
 *
 * The secrets are in sealed files under the root here (GENIE_SECRET_BACKEND=file), so "the keychain of the rebuilt
 * machine is empty" is: the State list copied WITHOUT `secrets/`. THE CONTROL is the same copy WITH it: then the agents'
 * keys, this machine's key and the pairing are held, and only the two sign-ins this test never had a secret for are said.
 * (Tynn and GitHub are on record with no credential in both runs: a real one would be used against the real services.)
 *
 * Runs in the test VMs (spawns processes); never on the owner's desktop.
 */

const made: string[] = [];
const children: ChildProcess[] = [];
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const put = (home: string, relative: string, text: string): void => { const file = join(home, ...relative.split('/')); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }); };

interface Running { child: ChildProcess; home: string; record: HostRecord; log: () => string }

async function startHost(home: string, keyFile: string): Promise<Running> {
    let log = '';
    const child = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'p7-rebuild-test', GENIE_HOST_IDLE_MS: '600000', GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: keyFile },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout?.on('data', (d) => { log += String(d); });
    child.stderr?.on('data', (d) => { log += String(d); });
    const deadline = Date.now() + 150_000;
    for (;;) {
        const record = parseHostRecord(await readFile(join(home, 'runtime', 'host.json'), 'utf8').catch(() => null));
        if (record && record.pid === child.pid) return { child, home, record, log: () => log };
        if (child.exitCode !== null) throw new Error(`genie-host exited ${child.exitCode} before serving:\n${log}`);
        if (Date.now() > deadline) throw new Error(`genie-host did not serve in time:\n${log}`);
        await sleep(50);
    }
}

async function stopHost(host: Running): Promise<void> {
    if (host.child.exitCode === null) { host.child.kill('SIGKILL'); await new Promise((done) => host.child.once('exit', done)); }
    await sleep(300);
}

/** A window on that host: the engine link, and main's own protocol client tunnelled over it (genie-host-process.test.ts). */
async function windowOn(host: Running): Promise<{ own: OwnProtocolClient; close(): void }> {
    const token = (await readFile(join(host.home, 'runtime', 'host.token'), 'utf8')).trim();
    const transport = await connectSocket(host.record.endpoint);
    const client = new SessionEngineClient({ env: () => ({ ...process.env }) });
    expect(await client.connect(transport, token)).toMatchObject({ ok: true });
    const own = ownProtocolClient();
    const bridge = tunnelDoor(own.door, tunnelLinkOf(client), { own: true });
    return { own, close: () => { bridge.dispose(); transport.close(); } };
}

async function ask(own: OwnProtocolClient, method: Parameters<OwnProtocolClient['call']>[0], args: unknown[]): Promise<OwnCallAnswer> {
    const deadline = Date.now() + 45_000;
    for (;;) {
        const answer = await own.call(method, args);
        if (answer.ok || !/still (starting|opening)/.test(answer.reason) || Date.now() > deadline) return answer;
        await sleep(200);
    }
}
const valueOf = <T>(answer: OwnCallAnswer): T => { if (!answer.ok) throw new Error(`refused: ${answer.reason}`); return answer.value as T; };

/** What the host itself answers about the work it holds. */
async function workOf(own: OwnProtocolClient): Promise<{ agents: string[]; workspaces: string[]; mail: string; flows: string }> {
    const snapshot = valueOf<{ agents: Array<{ id: string; name: string }>; workspaces: Array<{ id: string }> | null }>(await ask(own, 'snapshot', []));
    const features = valueOf<FeatureData>(await ask(own, 'features.snapshot', []));
    return {
        agents: snapshot.agents.map((a) => `${a.id} ${a.name}`).sort(),
        workspaces: (snapshot.workspaces ?? []).map((w) => w.id).sort(),
        mail: JSON.stringify(features.inbox),
        flows: JSON.stringify(features.flows),
    };
}

/** The Deck the host says, once it has settled on the attach items expected (or the time is up: then what it said). */
async function attachDeck(own: OwnProtocolClient, expected: readonly string[]): Promise<DeckItem[]> {
    let deck: readonly DeckItem[] = [];
    const stop = own.watchDeck((items) => { deck = items; });
    const mine = (): string[] => deck.filter((i) => i.id.startsWith('genie:attach:')).map((i) => i.id.slice('genie:attach:'.length)).sort();
    const deadline = Date.now() + 45_000;
    while (JSON.stringify(mine()) !== JSON.stringify([...expected].sort()) && Date.now() < deadline) await sleep(200);
    // Settled: it is still that a moment later (nothing is on its way in or out).
    await sleep(1_500);
    stop();
    return deck.filter((i) => i.id.startsWith('genie:attach:'));
}

const AGENT_KEY_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const AGENT_KEY_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const PAIRED = 'wss://other-machine.example/ws';
const THREADS = { 'thread-one.jsonl': '{"turn":1,"text":"first agent, mid-conversation"}\n{"turn":2,"text":"and on"}\n', 'thread-two.jsonl': '{"turn":1,"text":"second agent, mid-conversation"}\n' };

const LEFT_IN_THREADS = ['5ab2ad554899ec5e4af1175766e17108.json.lock', '5ab2ad554899ec5e4af1175766e17108.json.lock.candidate-e6c220b1dfe2b399f1836ae94215be80', '5ab2ad554899ec5e4af1175766e17108.index.json.4242.tmp'];
/** The STATE files of a folder under a root, by the rule table: never a raw listing, which reads another process's locks and temp files too. */
const stateFilesOf = (root: string, folder: string): string[] => readdirSync(join(root, ...folder.split('/'))).filter((name) => classifyDataPath(`${folder}/${name}`)?.kind === 'state').sort();
let keyFile: string;
let origin: string;
let workspace: string;
let before: Awaited<ReturnType<typeof workOf>>;
let stateList: Array<{ path: string; travels: boolean }>;
let machineList: string[];
let atStart: string[];
const agents = [
    { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'first' }), threadId: 'thread-one' },
    { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'second' }), threadId: 'thread-two' },
];

beforeAll(async () => {
    keyFile = join(temp('genie-p7-rebuild-key-'), 'secret.key');
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    // Owner-only, as the host demands of its key file: an ACL on Windows, the mode above on POSIX.
    await restrictPrivateFile(keyFile);
    origin = temp('genie-p7-rebuild-origin-');
    workspace = temp('genie-p7-rebuild-ws-');

    // WHAT THE ROOT POINTS AT, as the host's own stores write it; and the secrets, where this host keeps them.
    put(origin, 'credentials/tynn.json', JSON.stringify({ version: 1, state: 'signed-in', host: TYNN_HOST, userId: 'user_seed', scopes: PAIRING_SCOPES, usedCodes: [] }));
    put(origin, 'github.json', JSON.stringify({ version: 1, state: 'signed-in', login: 'octo-seed', name: 'Octo', source: 'sign-in' }));
    put(origin, 'workstation.json', JSON.stringify({ [TYNN_HOST]: { workstationId: 'ws_seed' } }));
    put(origin, 'runtime/device-hosts.json', JSON.stringify({ hosts: [PAIRED] }));
    put(origin, 'agent-credentials/agents.json', JSON.stringify({ version: 1, records: {
        [JSON.stringify(['user_seed', 'proj', agents[0]!.id])]: { userId: 'user_seed', projectId: 'proj', genieId: agents[0]!.id, remoteAgentId: 'r1', state: 'ready', publicId: AGENT_KEY_A },
        [JSON.stringify(['user_seed', 'proj', agents[1]!.id])]: { userId: 'user_seed', projectId: 'proj', genieId: agents[1]!.id, remoteAgentId: 'r2', state: 'ready', publicId: AGENT_KEY_B },
    } }));
    for (const [name, text] of Object.entries(THREADS)) put(origin, `runtime/sessions/${name}`, text);
    const secrets = await openSecretKeychain({ GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: keyFile }, origin);
    if (secrets.kind !== 'file') throw new Error(`the file secret store did not open: ${JSON.stringify(secrets)}`);
    for (const [name, value] of [
        [`tynn/agent/${AGENT_KEY_A}`, `rpk_${AGENT_KEY_A}.${'a'.repeat(64)}`], [`tynn/agent/${AGENT_KEY_B}`, `rpk_${AGENT_KEY_B}.${'b'.repeat(64)}`],
        [`workstation/${TYNN_HOST}`, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
        [`device/${PAIRED}`, 'device-token-seed'],
    ] as const) expect(await secrets.keychain.set(name, value)).toEqual({ ok: true });

    // THE HOST LIVES ON IT: the registry, mail and a flow, written by the host itself over its protocol.
    const host = await startHost(origin, keyFile);
    const w = await windowOn(host);
    expect(await ask(w.own, 'registry.write', ['changeWorkspaces', [{ add: [{ id: 'ws', path: workspace }] }]])).toMatchObject({ ok: true });
    expect(await ask(w.own, 'registry.write', ['changeAgents', [{ add: agents }]])).toMatchObject({ ok: true });
    expect(await ask(w.own, 'features.act', [{ kind: 'inbox.send', to: 'first', text: 'mail that waited through the rebuild' }])).toMatchObject({ ok: true });
    // The form's own default flow (hourly, one log step), not armed: an empty graph is refused by the flow door (the RED run said so).
    expect(await ask(w.own, 'features.act', [{ kind: 'flows.create', form: { ...flowFormDefaults({ workspaceId: 'ws' }), name: 'the flow that came back' } }])).toMatchObject({ ok: true });
    before = await workOf(w.own);
    w.close();
    const manifest = JSON.parse(readFileSync(join(origin, 'data-root.json'), 'utf8')) as { state: Array<{ path: string; travels: boolean }>; machine: string[] };
    stateList = manifest.state;
    machineList = manifest.machine;
    const { DATA_ROOT_RULES } = await import('../src/main/data-root.js');
    atStart = DATA_ROOT_RULES.filter((r) => r.atStart === true).map((r) => r.path);
    await stopHost(host);
    // WHAT A HOST THAT WAS KILLED MID-WRITE LEAVES in the threads folder, put there on purpose (gate 1124-052313-102a95 met
    // one by chance: a lock being taken while this file listed the folder): a lock, a lock being taken, a temp file.
    for (const name of LEFT_IN_THREADS) put(origin, `runtime/sessions/${name}`, 'left by a process that is gone');
}, 300_000);

afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await sleep(500);
    for (const d of made) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** ONLY THE STATE LIST, from the manifest the host wrote, into a fresh root. */
function putBack(options: { secrets: boolean }): string {
    const home = temp('genie-p7-rebuild-new-');
    for (const entry of stateList) {
        if (entry.path === 'secrets/' && !options.secrets) continue;
        const relative = entry.path.replace(/\/$/, '');
        const from = join(origin, ...relative.split('/'));
        if (!existsSync(from)) continue;
        const to = join(home, ...relative.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        // The state INSIDE a state folder, as the manifest says it: what its rule names as transient (a lock, a temp file) is not put back.
        cpSync(from, to, { recursive: true, filter: (source) => source === from || classifyDataPath(`${relative}${source.slice(from.length).replace(/\\/g, '/')}`)?.kind !== 'machine' });
        // SQLite's own files travel with their database.
        for (const side of ['-wal', '-shm']) if (existsSync(`${from}${side}`)) cpSync(`${from}${side}`, `${to}${side}`);
    }
    return home;
}

describe('wired: a change in what could not be restored reaches every Deck that is watching', () => {
    it('genie-host touches its estate when the attach items change, as it does for an elevation', () => {
        // The working tree's line ends are the machine's (CRLF on Windows): read as LF.
        const host = readFileSync('src/main/genie-host.ts', 'utf8').split(String.fromCharCode(13)).join('');
        expect(host).toContain('\n    attachHost.onChange(() => { phoneTouch(); });\n');
        // CONTROL: the neighbour it is modelled on is found the same way.
        expect(host).toContain('\n    hostingElevation.onChange(() => { phoneTouch(); });\n');
    });
});

describe('the fixture: a root a host really lived on', () => {
    it('holds the work (CONTROL for everything below: two agents, a workspace, the mail, the flow, the threads)', () => {
        expect(before.agents).toEqual(agents.map((a) => `${a.id} ${a.name}`).sort());
        expect(before.workspaces).toEqual(['ws']);
        expect(before.mail).toContain('mail that waited through the rebuild');
        expect(before.flows).toContain('the flow that came back');
        expect(stateFilesOf(origin, 'runtime/sessions')).toEqual(Object.keys(THREADS).sort());
        // CONTROL: the leftovers are really in that folder, beside the threads.
        for (const name of LEFT_IN_THREADS) expect(readdirSync(join(origin, 'runtime', 'sessions'))).toContain(name);
    });

    it('its manifest lists the state and the machine files, and the old machine’s machine files are really there to be left behind', () => {
        expect(stateList.map((s) => s.path)).toEqual(expect.arrayContaining(['runtime/agents.json', 'runtime/sessions/', 'runtime/inbox/', 'runtime/flows.json', 'secrets/']));
        for (const m of ['runtime/host.json', 'runtime/host.token', 'runtime/machine.json', 'mcp-endpoint.json']) { expect(machineList).toContain(m); expect(existsSync(join(origin, ...m.split('/'))), m).toBe(true); }
    });
});

describe.each([
    { name: 'REBUILT: the state put back, the keychain empty', secrets: false, expected: ['agent-keys', 'devices', 'github', 'tynn', 'workstation'] },
    { name: 'CONTROL: the state put back with the secrets', secrets: true, expected: ['github', 'tynn'] },
])('$name', ({ secrets, expected }) => {
    let home: string;
    let host: Running;
    let own: OwnProtocolClient;
    let close: () => void;
    let deck: DeckItem[];

    beforeAll(async () => {
        home = putBack({ secrets });
        // CONTROL: nothing of the machine came along.
        for (const m of ['runtime/host.json', 'runtime/host.token', 'runtime/machine.json', 'mcp-endpoint.json', 'runtime/children.json', 'runtime/ptys.json']) expect(existsSync(join(home, ...m.split('/'))), m).toBe(false);
        host = await startHost(home, keyFile);
        ({ own, close } = await windowOn(host));
        deck = await attachDeck(own, expected);
    }, 300_000);
    afterAll(async () => { close?.(); if (host) await stopHost(host); });

    it('NO LOCK AND NO TEMP FILE OF THE OLD MACHINE CAME ALONG: the threads folder put back holds the threads', () => {
        const there = readdirSync(join(home, 'runtime', 'sessions'));
        expect(there.filter((name) => LEFT_IN_THREADS.includes(name))).toEqual([]);
        expect(stateFilesOf(home, 'runtime/sessions')).toEqual(Object.keys(THREADS).sort());
    });

    it('the host says it found its state with no machine files', () => {
        expect(host.log()).toMatch(/data root: machine-files-gone/);
    });

    it('EVERY AGENT, THREAD, INBOX MESSAGE AND FLOW IS BACK, as the host answers them', async () => {
        const after = await workOf(own);
        expect(after.agents).toEqual(before.agents);
        expect(after.workspaces).toEqual(before.workspaces);
        expect(after.mail).toContain('mail that waited through the rebuild');
        expect(after.flows).toContain('the flow that came back');
        // The threads, byte for byte, and each agent still on its own.
        for (const [name, text] of Object.entries(THREADS)) expect(readFileSync(join(home, 'runtime', 'sessions', name), 'utf8')).toBe(text);
        // The registry on disk: every record the old machine left is there UNCHANGED, whole, and the two agents are on
        // their threads. The one record a host may add is its own agent (registry.ts seeds the Genie agent, in no
        // workspace, when it has none: two runs showed it added here and not on the old machine).
        const recordsOf = (root: string): Array<{ id: string; threadId: string | null; workspaceId: string }> => JSON.parse(readFileSync(join(root, 'runtime', 'agents.json'), 'utf8')) as Array<{ id: string; threadId: string | null; workspaceId: string }>;
        const left = recordsOf(origin);
        const now = recordsOf(home);
        expect(left.length).toBeGreaterThanOrEqual(2);
        for (const record of left) expect(now.find((r) => r.id === record.id)).toEqual(record);
        expect(now.filter((r) => !left.some((l) => l.id === r.id)).map((r) => r.workspaceId).filter((w) => w !== '__genie__')).toEqual([]);
        expect(now.map((r) => `${r.id} ${r.threadId}`)).toEqual(expect.arrayContaining(agents.map((a) => `${a.id} ${a.threadId}`)));
    });

    it('EVERY MACHINE FILE A HOST MAKES AT START IS MADE AGAIN, for this root', () => {
        expect(atStart.length).toBeGreaterThan(5);
        expect(atStart.filter((p) => !existsSync(join(home, ...p.split('/'))))).toEqual([]);
        expect(parseHostRecord(readFileSync(join(home, 'runtime', 'host.json'), 'utf8'))?.pid).toBe(host.child.pid);
        // A new token and a new endpoint: not the old machine's.
        expect(readFileSync(join(home, 'runtime', 'host.token'), 'utf8')).not.toBe(readFileSync(join(origin, 'runtime', 'host.token'), 'utf8'));
        expect(host.record.endpoint).not.toBe(parseHostRecord(readFileSync(join(origin, 'runtime', 'host.json'), 'utf8'))?.endpoint);
    });

    it(`IT SAYS WHAT IT COULD NOT RESTORE: ${expected.join(', ')}`, () => {
        expect(deck.map((i) => i.id.slice('genie:attach:'.length)).sort()).toEqual(expected);
        const by = (key: string): DeckItem | undefined => deck.find((i) => i.id === `genie:attach:${key}`);
        const options = (key: string): string[] => { const answer = by(key)?.answer; return answer?.kind === 'inline' ? answer.options.map((o) => o.label) : []; };
        expect(by('tynn')?.title).toBe('Sign in to Tynn again');
        expect(options('tynn')).toEqual(['Open Tynn in your browser', 'Dismiss']);
        expect(by('github')?.title).toBe('Sign in to GitHub again');
        expect(by('github')?.detail).toContain('octo-seed');
        if (!secrets) {
            expect(by('agent-keys')?.title).toBe('2 agents’ Tynn keys are not in this computer’s keychain');
            expect(options('agent-keys')).toEqual(['Make new keys', 'Dismiss']);
            expect(by('workstation')?.detail).toContain('This machine is workstation ws_seed');
            expect(options('workstation')).toEqual(['Register this machine again', 'Dismiss']);
            expect(by('devices')?.detail).toContain(PAIRED);
        }
        // No secret's value is said.
        expect(JSON.stringify(deck)).not.toMatch(/rpk_|device-token-seed|PRIVATE KEY/);
    });

    it('an action that needs Tynn is refused in words while signed out, and the item stays; Dismiss puts one away for good', async () => {
        if (secrets) {
            // A WINDOW ALREADY WATCHING HEARS THE CHANGE (gate 1124-011334-e06033: a window that began watching before the
            // host's first look heard nothing, ever): one watch, kept open across the answer, with no new read asked for.
            let heard: readonly DeckItem[] = [];
            const stop = own.watchDeck((items) => { heard = items; });
            const mine = (): string[] => heard.filter((i) => i.id.startsWith('genie:attach:')).map((i) => i.id).sort();
            try {
                for (const end = Date.now() + 20_000; mine().length !== 2 && Date.now() < end;) await sleep(100);
                // CONTROL: the watch holds both before the answer.
                expect(mine()).toEqual(['genie:attach:github', 'genie:attach:tynn']);
                expect(await ask(own, 'features.act', [{ kind: 'deck.answer', item: { id: 'genie:attach:github' }, optionId: 'dismiss' }])).toMatchObject({ ok: true });
                for (const end = Date.now() + 20_000; mine().length !== 1 && Date.now() < end;) await sleep(100);
                expect(mine()).toEqual(['genie:attach:tynn']);
            } finally { stop(); }
            return;
        }
        const refused = await ask(own, 'features.act', [{ kind: 'deck.answer', item: { id: 'genie:attach:workstation' }, optionId: 'workstation-register' }]);
        expect(JSON.stringify(refused)).toContain('Sign in to Tynn first');
        expect((await attachDeck(own, expected)).map((i) => i.id.slice('genie:attach:'.length)).sort()).toEqual(expected);
        // Nothing was sent anywhere: the record still names the old workstation.
        expect(JSON.parse(readFileSync(join(home, 'workstation.json'), 'utf8'))).toEqual({ [TYNN_HOST]: { workstationId: 'ws_seed' } });
    }, 120_000);
});
