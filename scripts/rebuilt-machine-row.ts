/**
 * A DATA ROOT ATTACHED TO A REBUILT MACHINE (the host split P7.3, Tynn #419): the plan's VM row, with a real genie-host
 * as its own process, real provider processes and THE REAL OS KEYCHAIN (Credential Manager / the Secret Service).
 *
 *   node scripts/rebuilt-machine.mjs            (it runs this file through tsx)
 *
 * 1. A host lives on a root: two agents, each MID-CONVERSATION (the busy stub provider streams for as long as its turn
 *    lasts), an agent's Tynn key each, this machine's workstation key and a pairing in the keychain. CONTROL: with those
 *    held, the host's Deck says only the two sign-ins this row never had a secret for.
 * 2. The machine is rebuilt under it: the host and its providers are KILLED, every path of the manifest's Machine list is
 *    deleted, and the keychain entries are deleted. The State files are all that is left.
 * 3. The same build is started on them. It says it found its state with no machine files; every machine file a host
 *    makes at start is made again; the registry is the one that was left, record for record; each agent is started and
 *    goes on IN ITS OWN THREAD (the same thread file, what it held before still its beginning, and longer now); and the
 *    Deck says what could not be restored, each with its action: sign in to Tynn again, sign in to GitHub again, the
 *    agents' keys, this machine's registration, the pairing.
 * 4. Everything under the root is in the manifest's State or Machine list (the completeness row, on a root that has
 *    been lived on).
 *
 * The keychain entries are this row's own names (a workstation key for Tynn's host, two agent keys with fixed test ids, a
 * pairing with a .invalid machine); they are test words, removed at the end whatever happened. Tynn and GitHub are on
 * record with NO credential in both halves: a real one would be used against the real services.
 *
 * SAFETY: it starts genie-host and writes keychain entries, so it refuses anywhere but a test machine: CI, the test VMs
 * (user `genie`), or REBUILT_ROW_ALLOW=1. Never on the owner's desktop. Every wait has a deadline; the run is capped; its
 * own processes are ended and named at the end (scripts/end-own-tree.mjs on Windows).
 *
 * Prints a line per step, `### rebuilt-machine <check>=PASS|FAIL`, then `### rebuilt-machine=PASS|FAIL`. Exit 0, 1, or 2
 * (cannot run here).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DeckItem } from '../src/core/deck.js';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { TYNN_HOST } from '../src/core/tynn.js';
import { classifyDataPath, DATA_ROOT_RULES } from '../src/main/data-root.js';
import { connectSocket, pidAlive } from '../src/main/engine-launch.js';
import { ownProtocolClient, type OwnProtocolClient } from '../src/main/own-protocol-client.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { tunnelDoor, tunnelLinkOf } from '../src/main/window-tunnel.js';

if (!process.env['CI'] && userInfo().username !== 'genie' && process.env['REBUILT_ROW_ALLOW'] !== '1') {
    console.error('refusing: this starts genie-host and writes keychain entries; test machines only');
    process.exit(2);
}

const T0 = Date.now();
const since = (): string => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
let current = 'start';
const step = (what: string): void => { current = what; console.log(`[${since()}] ${what}`); };
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const failures: string[] = [];
function check(ok: boolean, name: string, detail = ''): void {
    console.log(`### rebuilt-machine ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures.push(name);
}
async function until<T>(what: string, ms: number, read: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value as T;
        if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await sleep(150);
    }
}

const TSX = import.meta.resolve('tsx');
const STUB = resolve('scripts/perf-lag/stub-codex-busy.mjs');
const KEY_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const KEY_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const PAIRED = 'wss://rebuilt-machine-row.invalid/ws';
const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const SECRETS: ReadonlyArray<readonly [string, string]> = [
    [`tynn/agent/${KEY_A}`, `rpk_${KEY_A}.${'a'.repeat(64)}`],
    [`tynn/agent/${KEY_B}`, `rpk_${KEY_B}.${'b'.repeat(64)}`],
    [`workstation/${TYNN_HOST}`, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    [`device/${PAIRED}`, 'rebuilt-machine-row-test-word'],
];

interface Entry { getPassword(): Promise<string | null | undefined>; setPassword(value: string): Promise<void>; deletePassword(): Promise<boolean> }
const { AsyncEntry } = createRequire(`${process.cwd()}/`)('@napi-rs/keyring') as { AsyncEntry: new (service: string, name: string, options: { linux: { store: string } }) => Entry };
const entry = (name: string): Entry => new AsyncEntry('Genie', name, { linux: { store: 'secret-service' } });
/** Presence only: the value is never kept or printed. */
const held = async (name: string): Promise<boolean> => { try { const v = await entry(name).getPassword(); return typeof v === 'string' && v.length > 0; } catch { return false; } };
const forget = async (name: string): Promise<void> => { try { await entry(name).deletePassword(); } catch { /* not there */ } };

const home = mkdtempSync(join(tmpdir(), 'genie-rebuilt-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'genie-rebuilt-ws-'));
const runtime = join(home, 'runtime');
const put = (relative: string, text: string): void => { const file = join(home, ...relative.split('/')); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }); };
const children: ChildProcess[] = [];
const everPids = new Set<number>();

interface Running { child: ChildProcess; record: HostRecord; log: () => string }
async function startHost(): Promise<Running> {
    let log = '';
    const child = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'rebuilt-machine-row', GENIE_HOST_IDLE_MS: '600000', GENIE2_CODEX_BINARY: STUB, GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    if (child.pid) everPids.add(child.pid);
    child.stdout?.on('data', (d) => { log += String(d); });
    child.stderr?.on('data', (d) => { log += String(d); });
    const record = await until('host.json with this host’s pid', 150_000, () => {
        if (child.exitCode !== null) throw new Error(`genie-host exited ${child.exitCode} before serving:\n${log.slice(-3000)}`);
        let text: string | null = null;
        try { text = readFileSync(join(runtime, 'host.json'), 'utf8'); } catch { /* not yet */ }
        const r = parseHostRecord(text);
        return r && r.pid === child.pid ? r : null;
    });
    return { child, record, log: () => log };
}

interface Window { client: SessionEngineClient; own: OwnProtocolClient; close(): void }
/** The thread each agent's provider named: a window hears it and writes it to the registry (main.ts does); this row is that window. */
const threadHeard = new Map<string, string>();
async function windowOn(host: Running): Promise<Window> {
    const token = readFileSync(join(runtime, 'host.token'), 'utf8').trim();
    const transport = await connectSocket(host.record.endpoint);
    const client = new SessionEngineClient({ env: () => ({ ...process.env, GENIE2_CODEX_BINARY: STUB }), onThreadId: (agentId, threadId) => { threadHeard.set(agentId, threadId); } });
    const connected = await client.connect(transport, token);
    if (!(connected as { ok?: boolean }).ok) throw new Error(`the window was refused: ${JSON.stringify(connected)}`);
    const own = ownProtocolClient();
    const bridge = tunnelDoor(own.door, tunnelLinkOf(client), { own: true });
    return { client, own, close: () => { bridge.dispose(); transport.close(); } };
}
async function ask(own: OwnProtocolClient, method: Parameters<OwnProtocolClient['call']>[0], args: unknown[]): Promise<{ ok: boolean; reason?: string }> {
    const deadline = Date.now() + 45_000;
    for (;;) {
        const answer = await own.call(method, args);
        if (answer.ok || !/still (starting|opening)/.test(answer.reason) || Date.now() > deadline) return answer;
        await sleep(200);
    }
}

/** The attach items on the host's Deck, once they are the ones expected (or the time is up: then what it said). */
async function attachDeck(own: OwnProtocolClient, expected: readonly string[]): Promise<DeckItem[]> {
    let deck: readonly DeckItem[] = [];
    const stop = own.watchDeck((items) => { deck = items; });
    const mine = (): string[] => deck.filter((i) => i.id.startsWith('genie:attach:')).map((i) => i.id.slice('genie:attach:'.length)).sort();
    const deadline = Date.now() + 45_000;
    while (JSON.stringify(mine()) !== JSON.stringify([...expected].sort()) && Date.now() < deadline) await sleep(200);
    await sleep(1_500);
    stop();
    return deck.filter((i) => i.id.startsWith('genie:attach:'));
}
const keysOf = (items: readonly DeckItem[]): string[] => items.map((i) => i.id.slice('genie:attach:'.length)).sort();
const labelsOf = (items: readonly DeckItem[], key: string): string[] => { const a = items.find((i) => i.id === `genie:attach:${key}`)?.answer; return a?.kind === 'inline' ? a.options.map((o) => o.label) : []; };

/** The agents' thread logs: name → bytes. A thread's `.lock`, `.tmp` and index come and go with every write. */
function threads(): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const dir = join(runtime, 'sessions');
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        if (!name.endsWith('.jsonl')) continue;
        try { out.set(name, readFileSync(join(dir, name))); } catch { /* gone between the two reads */ }
    }
    return out;
}
const providerPids = (): number[] => {
    try { return (JSON.parse(readFileSync(join(runtime, 'children.json'), 'utf8')) as { records: Array<{ processes: Array<{ pid: number }> }> }).records.flatMap((r) => r.processes.map((p) => p.pid)); } catch { return []; }
};
const registryOnDisk = (): AgentRecord[] => JSON.parse(readFileSync(join(runtime, 'agents.json'), 'utf8')) as AgentRecord[];
/** Every record that was left is there unchanged; anything more is the host's own agent, which is in no workspace. */
const keptWhole = (left: readonly AgentRecord[], now: readonly AgentRecord[]): string => {
    const changed = left.filter((l) => JSON.stringify(now.find((r) => r.id === l.id)) !== JSON.stringify(l)).map((l) => l.name);
    const added = now.filter((r) => !left.some((l) => l.id === r.id) && r.workspaceId !== '__genie__').map((r) => r.name);
    return [...changed.map((n) => `${n} changed or gone`), ...added.map((n) => `${n} added`)].join('; ');
};

/** Everything under the root, relative; a folder some rule lists whole is one entry. */
function entriesOf(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
            const relative = `${prefix}${d.name}`;
            if (d.isDirectory() && classifyDataPath(relative)?.path !== `${relative}/`) { walk(join(dir, d.name), `${relative}/`); continue; }
            out.push(d.isDirectory() ? `${relative}/` : relative);
        }
    };
    walk(home, '');
    return out.sort();
}

async function startWorking(w: Window, record: AgentRecord): Promise<void> {
    const started = await w.client.start(record, workspace);
    if (!(started as { ok?: boolean }).ok) throw new Error(`${record.name} did not start: ${JSON.stringify(started)}`);
    await until(`${record.name} to take a prompt`, 90_000, () => w.client.promptable(record.id) !== null);
    if (!(await w.client.prompt(record.id, 'work', 'you'))) throw new Error(`${record.name} did not take the prompt`);
    await until(`${record.name} to stream`, 90_000, () => w.client.rowsFor(record.id).length > 3);
}

async function cleanup(): Promise<void> {
    step('cleanup: ending this row’s processes, forgetting its keychain entries, removing its folders');
    for (const pid of providerPids()) everPids.add(pid);
    for (const c of children) if (c.exitCode === null) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    if (process.platform === 'win32') {
        const mod = './end-own-tree.mjs';
        const { endOwnRun } = (await import(mod)) as { endOwnRun(input: { hostPid: number | null; others: number[]; since: number; log: (line: string) => void }): Promise<{ ok: boolean; words: string }> };
        const [hostPid, ...others] = [...everPids];
        const ended = await endOwnRun({ hostPid: hostPid ?? null, others, since: T0, log: (line) => console.log(`    ${line}`) }).catch((error: unknown) => ({ ok: false, words: String(error) }));
        if (!ended.ok) check(false, 'nothing-left-running', ended.words);
    } else {
        for (const pid of everPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        await sleep(500);
        const left = [...everPids].filter(pidAlive);
        if (left.length > 0) check(false, 'nothing-left-running', `pids ${left.join(', ')}`);
    }
    for (const [name] of SECRETS) await forget(name);
    for (const dir of [home, workspace]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* a handle still closing */ } }
}

const watchdog = setTimeout(() => { console.log(`### rebuilt-machine deadline=FAIL  in: ${current}`); void cleanup().finally(() => process.exit(1)); }, Number(process.env['REBUILT_ROW_DEADLINE_MS'] ?? 360_000));

async function main(): Promise<void> {
    step('1.1 the keychain answers (a write, a read back, a delete: a probe entry of this row’s own)');
    await entry('rebuilt-machine-row/probe').setPassword('probe');
    const probed = await held('rebuilt-machine-row/probe');
    await forget('rebuilt-machine-row/probe');
    if (!probed) { console.log('### rebuilt-machine keychain=FAIL  the OS keychain did not keep a probe entry: this row cannot say anything here'); process.exitCode = 1; return; }

    step('1.2 seeding the root’s pointers and the keychain');
    const agents = [agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'first' }), agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'second' })];
    put('credentials/tynn.json', JSON.stringify({ version: 1, state: 'signed-in', host: TYNN_HOST, userId: 'user_row', scopes: SCOPES, usedCodes: [] }));
    put('github.json', JSON.stringify({ version: 1, state: 'signed-in', login: 'octo-row', name: null, source: 'sign-in' }));
    put('workstation.json', JSON.stringify({ [TYNN_HOST]: { workstationId: 'ws_row' } }));
    put('runtime/device-hosts.json', JSON.stringify({ hosts: [PAIRED] }));
    put('agent-credentials/agents.json', JSON.stringify({ version: 1, records: Object.fromEntries(agents.map((a, i) => [JSON.stringify(['user_row', 'proj', a.id]), { userId: 'user_row', projectId: 'proj', genieId: a.id, remoteAgentId: `r${i}`, state: 'ready', publicId: i === 0 ? KEY_A : KEY_B }])) }));
    for (const [name, value] of SECRETS) await entry(name).setPassword(value);
    check((await Promise.all(SECRETS.map(([name]) => held(name)))).every(Boolean), '1-keychain-holds-the-four', 'the control for "missing" below');

    step('1.3 starting genie-host on the root');
    const first = await startHost();
    const w1 = await windowOn(first);
    check((await ask(w1.own, 'registry.write', ['writeWorkspaces', [[{ id: 'ws', path: workspace }]]])).ok && (await ask(w1.own, 'registry.write', ['writeAgents', [agents]])).ok, '2-registry-written');

    step('1.4 two agents, each mid-conversation');
    for (const a of agents) await startWorking(w1, a);
    const pidsBefore = await until('two providers in the spawn ledger', 30_000, () => { const p = providerPids(); return p.length >= 2 ? p : null; });
    for (const p of pidsBefore) everPids.add(p);
    check(pidsBefore.every(pidAlive), '3-two-providers-running', `pids ${pidsBefore.join(', ')}`);
    await until('the host to name each agent’s thread', 60_000, () => agents.every((a) => threadHeard.has(a.id))).catch(() => null);
    const withThreads = registryOnDisk().map((r) => (threadHeard.has(r.id) ? { ...r, threadId: threadHeard.get(r.id)! } : r));
    const wrote = agents.every((a) => threadHeard.has(a.id)) && (await ask(w1.own, 'registry.write', ['writeAgents', [withThreads]])).ok;
    const recorded = wrote ? await until('each agent’s thread on record', 30_000, () => { const r = registryOnDisk().filter((x) => agents.some((a) => a.id === x.id)); return r.length === 2 && r.every((x) => typeof x.threadId === 'string' && x.threadId.length > 0) ? r : null; }).catch(() => null) : null;
    check(recorded !== null, '4-each-agent-has-a-thread-on-record', recorded ? recorded.map((r) => r.threadId).join(', ') : `heard ${threadHeard.size} of 2; agents.json says ${JSON.stringify(registryOnDisk().map((r) => r.threadId))}`);
    const growing = threads();
    await sleep(2_000);
    const grown = threads();
    check(grown.size >= 2 && [...grown].filter(([name, bytes]) => bytes.length > (growing.get(name)?.length ?? 0)).length >= 2, '5-both-threads-growing', `${grown.size} thread log(s)`);

    step('1.5 CONTROL: with the keys held, the Deck says only the two sign-ins');
    const deckBefore = await attachDeck(w1.own, ['github', 'tynn']);
    check(JSON.stringify(keysOf(deckBefore)) === JSON.stringify(['github', 'tynn']), '6-control-only-the-two-sign-ins', keysOf(deckBefore).join(', '));
    w1.close();

    step('2.1 the machine goes: the host and its providers are killed, mid-conversation');
    const registryLeft = registryOnDisk();
    const oldToken = readFileSync(join(runtime, 'host.token'), 'utf8');
    first.child.kill('SIGKILL');
    await until('the host to be gone', 15_000, () => first.child.exitCode !== null || first.child.signalCode !== null);
    for (const p of providerPids()) { everPids.add(p); try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    await until('the providers to be gone', 20_000, () => pidsBefore.every((p) => !pidAlive(p)));
    await sleep(500);
    const threadsLeft = threads();

    step('2.2 every Machine path of the manifest is deleted; the keychain entries are deleted');
    const manifest = JSON.parse(readFileSync(join(home, 'data-root.json'), 'utf8')) as { state: Array<{ path: string }>; machine: string[] };
    const there = manifest.machine.filter((p) => existsSync(join(home, ...p.replace(/\/$/, '').split('/'))));
    check(['runtime/host.json', 'runtime/host.token', 'runtime/machine.json', 'runtime/children.json', 'mcp-endpoint.json', 'runtime/lifecycle.log'].every((p) => there.includes(p)), '7-control-machine-files-were-there', `${there.length} machine path(s)`);
    for (const p of manifest.machine) rmSync(join(home, ...p.replace(/\/$/, '').split('/')), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    check(manifest.machine.every((p) => !existsSync(join(home, ...p.replace(/\/$/, '').split('/')))), '8-machine-files-gone');
    for (const [name] of SECRETS) await forget(name);
    check(!(await Promise.all(SECRETS.map(([name]) => held(name)))).some(Boolean), '9-keychain-entries-gone');

    step('3.1 the same build, started on the State files');
    const second = await startHost();
    check(/data root: machine-files-gone/.test(second.log()), '10-says-machine-files-gone', (/data root: [^\n]*/.exec(second.log()) ?? ['no "data root:" line'])[0]);
    const atStart = DATA_ROOT_RULES.filter((r) => r.atStart === true).map((r) => r.path);
    const notMade = atStart.filter((p) => !existsSync(join(home, ...p.split('/'))));
    check(atStart.length > 5 && notMade.length === 0, '11-machine-files-made-again', notMade.length > 0 ? `not made: ${notMade.join(', ')}` : `${atStart.length} at-start path(s)`);
    check(readFileSync(join(runtime, 'host.token'), 'utf8') !== oldToken && second.record.pid !== first.record.pid, '12-a-new-token-and-a-new-host');
    check(registryLeft.length >= 2 && keptWhole(registryLeft, registryOnDisk()) === '', '13-registry-record-for-record', keptWhole(registryLeft, registryOnDisk()));

    step('3.2 it says what it could not restore');
    const w2 = await windowOn(second);
    const expected = ['agent-keys', 'devices', 'github', 'tynn', 'workstation'];
    const deckAfter = await attachDeck(w2.own, expected);
    check(JSON.stringify(keysOf(deckAfter)) === JSON.stringify(expected), '14-every-missing-secret-is-said', keysOf(deckAfter).join(', '));
    check(JSON.stringify(labelsOf(deckAfter, 'tynn')) === JSON.stringify(['Open Tynn in your browser', 'Dismiss']) && JSON.stringify(labelsOf(deckAfter, 'github')) === JSON.stringify(['Sign in to GitHub', 'Dismiss'])
        && JSON.stringify(labelsOf(deckAfter, 'agent-keys')) === JSON.stringify(['Make new keys', 'Dismiss']) && JSON.stringify(labelsOf(deckAfter, 'workstation')) === JSON.stringify(['Register this machine again', 'Dismiss'])
        && JSON.stringify(labelsOf(deckAfter, 'devices')) === JSON.stringify(['Dismiss']), '15-each-with-its-action');
    check(deckAfter.find((i) => i.id === 'genie:attach:tynn')?.title === 'Sign in to Tynn again' && (deckAfter.find((i) => i.id === 'genie:attach:agent-keys')?.title ?? '').startsWith('2 agents'), '16-in-words');
    check(!/rpk_|test-word|PRIVATE KEY/.test(JSON.stringify(deckAfter)), '17-no-secret-is-said');

    step('3.3 each agent goes on in its own thread');
    const records = registryOnDisk().filter((r) => agents.some((a) => a.id === r.id));
    for (const record of records) await startWorking(w2, record);
    for (const p of providerPids()) everPids.add(p);
    await sleep(2_500);
    const threadsNow = threads();
    const same = [...threadsLeft].filter(([name, bytes]) => { const now = threadsNow.get(name); return now !== undefined && now.length > bytes.length && now.subarray(0, bytes.length).equals(bytes); });
    check(threadsLeft.size >= 2 && same.length === threadsLeft.size, '18-the-same-threads-longer-now', `${same.length} of ${threadsLeft.size} thread log(s) kept their beginning and grew`);
    check([...threadsNow.keys()].every((name) => threadsLeft.has(name)), '19-no-new-thread-was-begun', `${threadsNow.size} now, ${threadsLeft.size} before`);
    const threadsOnRecord = (records: readonly AgentRecord[]): string => JSON.stringify(records.filter((r) => agents.some((a) => a.id === r.id)).map((r) => `${r.id} ${r.threadId}`).sort());
    check(threadsOnRecord(registryOnDisk()) === threadsOnRecord(registryLeft) && !threadsOnRecord(registryLeft).includes('null'), '20-still-the-threads-on-record', threadsOnRecord(registryOnDisk()));

    step('4 everything under the root is in a list');
    const unlisted = entriesOf().filter((p) => classifyDataPath(p) === null);
    check(unlisted.length === 0, '21-everything-in-a-list', unlisted.join(', '));

    step('5 the host is told to leave');
    const left = await w2.client.shutdown().catch(() => false);
    await until('the host to exit', 30_000, () => second.child.exitCode !== null).catch(() => null);
    check(left === true && second.child.exitCode !== null, '22-host-left-when-told');
    w2.close();
}

main().catch((error: unknown) => { check(false, 'ran', `in "${current}": ${error instanceof Error ? error.stack ?? error.message : String(error)}`); })
    .then(cleanup)
    .then(() => {
        clearTimeout(watchdog);
        console.log(`### rebuilt-machine=${failures.length === 0 && process.exitCode !== 1 ? 'PASS' : 'FAIL'}${failures.length > 0 ? `  ${failures.join(', ')}` : ''}`);
        process.exit(failures.length === 0 && process.exitCode !== 1 ? 0 : 1);
    });
