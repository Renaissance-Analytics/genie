import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_PROTOCOL, parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { notAvailableHere } from '../src/core/host-runtime.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectSocket, pidAlive } from '../src/main/engine-launch.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SpawnHostClient } from '../src/main/spawn-host-client.js';
import type { FilesHubEvent } from '../src/main/files-watch-hub.js';
import { ownProtocolClient, type OwnCallAnswer, type OwnProtocolClient } from '../src/main/own-protocol-client.js';
import { tunnelDoor, tunnelLinkOf } from '../src/main/window-tunnel.js';
import type { HostedProcess } from '../src/main/process-book.js';
import type { FeatureData } from '../src/renderer/features.js';

// By its whole address: on Windows a process entry moves to the home folder first (process-start.ts), where a bare 'tsx' does not resolve for what the host starts.
const TSX = import.meta.resolve('tsx');

/**
 * THE HOST IS ITS OWN PROCESS, AND AN AGENT OUTLIVES ITS WINDOW (the host split, phase 1).
 *
 * The real `genie-host` entry (src/main/genie-host.ts), run as its own Node process, with a real provider process: the
 * busy stub codex (scripts/perf-lag/stub-codex-busy.mjs), the same App Server protocol the real CodexDriver speaks,
 * streaming a reply and running commands for as long as its turn lasts. A window is played by a `SessionEngineClient`
 * on the real socket. The window "crashes" (its socket is destroyed); the provider must keep running and keep writing,
 * and the next window must adopt the host and see the run — including what happened while no window was there.
 *
 * Runs in the test VMs (spawns processes); never on the owner's desktop.
 */

const STUB = resolve('scripts/perf-lag/stub-codex-busy.mjs');
let home: string;
let workspace: string;
let hostProcess: ChildProcess;
let hostLog = '';
let record: HostRecord;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- host log ---\n${hostLog}`);
        await sleep(100);
    }
}
/** A staging folder whose owner is gone: no process has this pid (above any OS's pid range) with this start time. */
const OLD_STAGING = '2147483000-1';
const readText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return null; } };

async function window(): Promise<{ client: SessionEngineClient; transport: ClientTransport }> {
    const token = (await readFile(join(home, 'runtime', 'host.token'), 'utf8')).trim();
    const transport = await connectSocket(record.endpoint);
    // The window's environment travels with every start and the host adopts it (hot-swappable toolchain), so the
    // window here must hold what a real window holds: the provider it is configured with.
    const client = new SessionEngineClient({ env: () => ({ ...process.env, GENIE2_CODEX_BINARY: STUB }) });
    const connected = await client.connect(transport, token);
    expect(connected).toMatchObject({ ok: true });
    return { client, transport };
}

/**
 * MAIN'S OWN PROTOCOL CLIENT OVER THIS WINDOW'S ENGINE LINK, tunnelled exactly as main.ts does it
 * (`tunnelDoor(ownProtocol.door, tunnelLinkOf(agentEngineLink.client), { own: true })`): what a window asks of genie-host
 * — features.act/snapshot, registry.write, deck.watch — goes over the one protocol, never the engine link's replicas.
 */
function ownOver(client: SessionEngineClient): { own: OwnProtocolClient; dispose(): void } {
    const own = ownProtocolClient();
    const bridge = tunnelDoor(own.door, tunnelLinkOf(client), { own: true });
    return { own, dispose: () => bridge.dispose() };
}

/** One call, asked again while genie-host is still opening the part that answers it (its process book, at boot). */
async function ask(own: OwnProtocolClient, method: Parameters<OwnProtocolClient['call']>[0], args: unknown[]): Promise<OwnCallAnswer> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        const answer = await own.call(method, args);
        if (answer.ok || !/still (starting|opening)/.test(answer.reason) || Date.now() > deadline) return answer;
        await sleep(200);
    }
}

/** The kept processes the window is shown: the features snapshot's hosting.processes. */
async function keptProcesses(own: OwnProtocolClient): Promise<readonly HostedProcess[]> {
    const answer = await own.call('features.snapshot', []);
    return answer.ok ? ((answer.value as FeatureData).hosting?.processes ?? []) : [];
}

/** The provider processes the host recorded for its agents (the spawn ledger, `runtime/children.json`). */
async function providerPids(): Promise<number[]> {
    const text = await readText(join(home, 'runtime', 'children.json'));
    if (!text) return [];
    const parsed = JSON.parse(text) as { records: Array<{ processes: Array<{ pid: number }> }> };
    return parsed.records.flatMap((r) => r.processes.map((p) => p.pid));
}

async function threadBytes(): Promise<number> {
    const dir = join(home, 'runtime', 'sessions');
    let total = 0;
    // The thread LOGS only. A thread's `.lock` comes and goes with every write: listed, then gone before its stat (CI,
    // 2026-11-01, ENOENT). A log that vanished between the two reads counts as nothing rather than failing the gauge.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.endsWith('.lock') || name.endsWith('.tmp')) continue;
        total += await stat(join(dir, name)).then((s) => s.size, () => 0);
    }
    return total;
}

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie-host-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'genie-host-ws-'));
    // The workspace its agents run in, as the host's registry knows it: the host prepares an agent, and refuses a workspace it has never heard of.
    await mkdir(join(home, 'runtime'), { recursive: true });
    await writeFile(join(home, 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'ws', path: workspace }]));
    // Old local staging a process long gone left behind (pid-started), and a folder that is not staging's (Tynn #955).
    await mkdir(join(home, 'runtime', 'local-staging', OLD_STAGING), { recursive: true });
    await writeFile(join(home, 'runtime', 'local-staging', OLD_STAGING, 'left.txt'), 'left behind\n');
    await mkdir(join(home, 'runtime', 'local-staging', 'not-staging'), { recursive: true });
    hostProcess = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        // The spawn host's real entry, as TypeScript (the host forks it with its own --import tsx).
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'test-build', GENIE2_CODEX_BINARY: STUB,
            // A Take Over's TUI (the tools test): a plain node in the pty, quoted for a path with spaces.
            GENIE2_CLAUDE_BINARY: `"${process.execPath}"`, GENIE_HOST_IDLE_MS: '600000', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostProcess.stdout?.on('data', (d) => { hostLog += String(d); });
    hostProcess.stderr?.on('data', (d) => { hostLog += String(d); });
    record = await until('host.json', async () => {
        const r = parseHostRecord(await readText(join(home, 'runtime', 'host.json')));
        return r && r.pid === hostProcess.pid ? r : null;
    }, 120_000);
}, 180_000);

afterAll(async () => {
    if (hostProcess.exitCode === null) hostProcess.kill('SIGKILL');
    for (const pid of await providerPids().catch(() => [])) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('genie-host as its own process', () => {
    it('writes host.json with its own pid, the protocol and the build it was started as', () => {
        expect(record).toMatchObject({ pid: hostProcess.pid, protocol: ENGINE_PROTOCOL, build: 'test-build' });
    });

    it('OLD LOCAL STAGING IS SWEPT WITH NO WINDOW EVER OPENED: genie-host sweeps it itself after boot (Tynn #955, 2g-4d E)', async () => {
        // Before any window() in this file: the sweep ran only in the window's composition before, so it never ran here.
        const staging = join(home, 'runtime', 'local-staging');
        await until('the old staging folder to be swept', () => !existsSync(join(staging, OLD_STAGING)), 30_000);
        // CONTROL: the sweep is staging's own, not a wipe: a folder that is not a staging folder is kept.
        expect(existsSync(join(staging, 'not-staging'))).toBe(true);
    }, 60_000);

    it('a second host for the same user finds the endpoint taken and exits, leaving the first serving', async () => {
        const second = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], { env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'other' }, stdio: 'ignore' });
        const code = await new Promise<number | null>((r) => second.once('exit', r));
        expect(code).toBe(0);
        expect(parseHostRecord(await readText(join(home, 'runtime', 'host.json')))?.pid).toBe(hostProcess.pid);
    }, 120_000);

    it('a SUPERVISED PROCESS outlives its window, and the next window finds it with its tag, its pid and what it printed (P2.1)', async () => {
        // The window's side, as main.ts builds it: a spawn client over the engine link to the host's `processes` child.
        const open = async () => {
            const w = await window();
            const spawn = new SpawnHostClient({ entry: '', link: w.client.spawnLink('processes') });
            w.client.onSpawnFrame('processes', (frame) => spawn.linkFrame(frame));
            return { ...w, spawn };
        };
        const first = await open();
        expect(await first.spawn.linkUp()).toEqual([]);
        const pty = first.spawn.ptyPort();
        const pids: number[] = [];
        pty.onPid?.((_id, pid) => pids.push(pid));
        // A script file, run WITHOUT a shell: no quoting goes through cmd.exe. On Windows `cmd /d /s /c` strips the line's
        // first and last quote, so a line that starts and ends quoted ("node" -e "...") is mangled and the shell exits at
        // once (unit (windows), 2026-11-01: the positive control below read the pid dead at 123 ms).
        await writeFile(join(workspace, 'ticker.cjs'), `setInterval(() => console.log('tick ' + Date.now()), 150);\n`);
        const started = pty.open({ cwd: workspace, command: `"${process.execPath}" ticker.cjs`, tag: { kind: 'process', processId: 'worker:ticks', workspaceId: 'ws' } });
        const pid = await until('the process pid', () => pids[0] ?? null, 30_000);
        expect(pidAlive(pid)).toBe(true); // positive control: the gauge sees it alive while its window is there

        first.transport.close(); // the window goes
        await sleep(2_000);
        expect(pidAlive(pid)).toBe(true); // it did not go with it

        const second = await open();
        const found = await second.spawn.linkUp();
        const mine = found.find((p) => p.id === started.id);
        expect(mine).toMatchObject({ pid, tag: { kind: 'process', processId: 'worker:ticks', workspaceId: 'ws' } });
        expect(mine!.scrollback).toMatch(/tick \d+/);

        // Taken back, it is the new window's to end: killed through the link, it is gone.
        second.spawn.adoptPty(mine!);
        expect(second.spawn.ptyPort().kill(started.id)).toBe(true);
        await until('the process to end', () => !pidAlive(pid), 15_000);
        second.transport.close();
    }, 120_000);

    it('GENIE\'S TOOLS OUTLIVE THE WINDOW (P3.1): with the window gone, agentinbox, ForceTheQuestion, knowledge, sites and services answer over real HTTP; a window tool refuses at once; the next window sees the question; the endpoint is the same', async () => {
        const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'teller' });
        const first = await window();
        const firstOwn = ownOver(first.client);
        // genie-host reads its own registry for records (Tynn #954, 2g-3): main writes it over the protocol's registry.write.
        expect(await ask(firstOwn.own, 'registry.write', ['writeAgents', [[agent]]])).toMatchObject({ ok: true });
        // A Take Over terminal's agent: genie-host starts its TUI and mints the id it calls Genie's tools by over HTTP. No
        // window says whose terminal it is (Tynn #1044: the window view carries no callers).
        expect(await first.client.takeOvers().start(agent.id)).toMatchObject({ ok: true });
        const terminalId = await until('the Take Over caller genie-host minted', async () => {
            await first.client.takeOvers().refresh();
            return Object.entries(first.client.takeOvers().callers()).find(([, c]) => c.agentId === agent.id)?.[0] ?? null;
        }, 30_000);
        const status = await first.client.mcpStatus();
        expect(status?.endpoint).not.toBeNull();
        const endpoint = status!.endpoint!;
        const call = async (name: string, args: Record<string, unknown>) => {
            const res = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...args, terminalId }, _meta: META } }) });
            const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
            return { isError: body.result?.isError ?? true, text: body.result?.content[0]?.text ?? JSON.stringify(body.error) };
        };
        // POSITIVE CONTROL: with the window here, the host's tool answers (the gauge can see a success).
        expect((await call('knowledge', { action: 'add', title: 'Before', body: 'with a window', scope: 'workspace' })).isError).toBe(false);

        firstOwn.dispose();
        first.transport.close(); // the window goes
        await sleep(500);

        const sent = await call('agentinbox', { action: 'send', to: 'human', text: 'shipped while you were away' });
        expect(sent).toMatchObject({ isError: false });
        const asked = await call('ForceTheQuestion', { questions: [{ header: 'Ship', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
        expect(asked.isError).toBe(false);
        const questionId = (JSON.parse(asked.text) as { questionId: string }).questionId;
        expect((await call('knowledge', { action: 'add', title: 'After', body: 'no window at all', scope: 'workspace' })).isError).toBe(false);
        // SITES AND SERVICES ARE THE HOST'S (Tynn #444): on beta.60 every agent's `sites` and `services` failed ("Genie's
        // window closed before it answered") while `processes` answered. With no window at all they answer here.
        const sitesListed = await call('sites', { action: 'list' });
        expect(sitesListed).toMatchObject({ isError: false });
        expect(JSON.parse(sitesListed.text)).toMatchObject({ ok: true, sites: [] });
        const servicesListed = await call('services', { action: 'list' });
        expect(servicesListed).toMatchObject({ isError: false });
        expect(JSON.parse(servicesListed.text)).toMatchObject({ ok: true, services: [] });
        // `status` of a site this workspace does not have: the sites tool's own answer, from the host's sites.
        const siteStatus = await call('sites', { action: 'status', site: 'teller' });
        expect(siteStatus.isError).toBe(true);
        expect(JSON.parse(siteStatus.text)).toEqual({ ok: false, error: 'no site "teller" in this workspace; `sites list` shows them' });
        // A window tool: refused AT ONCE, in words (timed: a hang would be the failure).
        const t0 = Date.now();
        // openFileForUser: a window tool, open to every agent (workspaceTabs is offered only to a workspace's default agent, so
        // its call is refused before any handler). `sites open` is genie-host's since Tynn #1046 D2, with the rest of `sites`.
        const refused = await call('openFileForUser', { path: 'README.md' });
        expect(refused.isError).toBe(true);
        // This host runs on plain Node under the test (tsx, no Electron), so hostCapabilities() gives it no window: the window
        // tool says it is not available on this host (P10.1d). An Electron host's "window, which is closed" wording is pinned
        // in mcp-host-tools.test.ts.
        expect(refused.text).toBe(notAvailableHere('openFileForUser', 'a Genie window'));
        expect(Date.now() - t0).toBeLessThan(5_000);
        // checkIssues IS THE HOST'S (Tynn #934 task #1474): with no window it answers from this host's own IssueWatch. This
        // workspace is linked to no Tynn project, and it says so in the tool's own words; nothing is forwarded.
        const issues = await call('checkIssues', {});
        expect(issues.isError).toBe(false);
        expect(JSON.parse(issues.text)).toEqual({ ok: false, reason: 'this workspace is not linked to a Tynn project (project.json tynn.projectId)' });

        // The next window, over the protocol: the question waits on the Deck genie-host says (deck.watch), the mail is in
        // its inbox (the features snapshot), the knowledge is found (knowledge.search), the endpoint is the one agents have.
        const second = await window();
        const secondOwn = ownOver(second.client);
        let deck: readonly { id: string }[] = [];
        const stopDeck = secondOwn.own.watchDeck((items) => { deck = items; });
        try {
            await until('the question on the Deck the next window hears', () => deck.some((item) => item.id === questionId), 30_000);
            const snapshot = await ask(secondOwn.own, 'features.snapshot', []);
            expect(snapshot).toMatchObject({ ok: true });
            expect(((snapshot as { value: FeatureData }).value.inbox?.unread ?? []).map((m) => m.text)).toContain('shipped while you were away');
            const found = await ask(secondOwn.own, 'features.act', [{ kind: 'knowledge.search', query: 'no window' }]);
            expect(found).toMatchObject({ ok: true });
            expect(((found as { value: FeatureData }).value.knowledge.hits ?? []).map((h) => h.title)).toContain('After');
            expect((await second.client.mcpStatus())?.endpoint).toEqual(endpoint);
        } finally { stopDeck(); secondOwn.dispose(); }
        second.transport.close();
    }, 120_000);

    it('THE HOST KEEPS ALIVE WHAT THE PERSON LEFT RUNNING (P3.3b): a `restart: always` process kept over the protocol is started again by the host when it is killed with no window; the next window sees it; Stop from a window ends it for good', async () => {
        await writeFile(join(workspace, 'worker.cjs'), `setInterval(() => console.log('working ' + process.pid), 200);\n`);
        const first = await window();
        const firstOwn = ownOver(first.client);
        // The person's "keep this running", as the Hosting tab sends it: features.act hosting.createProcess.
        expect(await ask(firstOwn.own, 'features.act', [{ kind: 'hosting.createProcess', workspaceId: 'ws', workspacePath: workspace, name: 'worker', command: `"${process.execPath}" worker.cjs`, restart: 'always' }])).toMatchObject({ ok: true });
        const worker = async (own: OwnProtocolClient) => (await keptProcesses(own)).find((p) => p.workspaceId === 'ws' && p.name === 'worker') ?? null;
        const kept = await until('the worker running with a pid, in the snapshot', async () => { const p = await worker(firstOwn.own); return p && p.state === 'running' && p.pid !== null ? p : null; }, 30_000);
        const firstPid = kept.pid!;
        expect(pidAlive(firstPid)).toBe(true); // CONTROL: the gauge sees the worker alive

        firstOwn.dispose();
        first.transport.close(); // the window goes
        await sleep(500);
        process.kill(firstPid, 'SIGKILL'); // the worker crashes, with nobody watching

        // The host's restart policy, with no window: a new worker comes up, and the next window is shown it.
        const second = await window();
        const secondOwn = ownOver(second.client);
        const restarted = await until('a new worker pid, in the snapshot', async () => {
            const p = await worker(secondOwn.own);
            return p && p.id === kept.id && p.state === 'running' && p.pid !== null && p.pid !== firstPid ? p : null;
        }, 30_000);
        const secondPid = restarted.pid!;
        expect(pidAlive(secondPid)).toBe(true);
        expect(restarted.restarts).toBeGreaterThanOrEqual(1);

        // Stop from the window, as its Stop button sends it: ended, and NOT started again by the host.
        expect(await ask(secondOwn.own, 'features.act', [{ kind: 'hosting.stopProcess', processId: kept.id }])).toMatchObject({ ok: true });
        await until('the worker to end', () => !pidAlive(secondPid), 15_000);
        await sleep(3_000); // longer than the first restart backoff (1 s): a restart would have come by now
        const after = await worker(secondOwn.own);
        expect(after?.state).toBe('stopped');
        expect(after?.pid === null || after?.pid === secondPid).toBe(true);
        // Kept, and stopped by the person: removed so the next tests' hosts start nothing of it.
        expect(await ask(secondOwn.own, 'features.act', [{ kind: 'hosting.removeProcess', processId: kept.id }])).toMatchObject({ ok: true });
        secondOwn.dispose();
        second.transport.close();
    }, 120_000);

    it('A TERMINAL OUTLIVES ITS WINDOW (P3.3e): opened from a window, still running with what it printed when the next window joins; closed from it, gone', async () => {
        await writeFile(join(workspace, 'term-ticker.cjs'), `setInterval(() => console.log('term ticking'), 200);\n`);
        const first = await window();
        const opened = await first.client.terminals().openReady({ workspaceId: 'ws', cwd: workspace, command: `"${process.execPath}" term-ticker.cjs`, limited: false });
        expect(opened.pid).toBeGreaterThan(0);
        expect(pidAlive(opened.pid)).toBe(true); // CONTROL: the gauge sees the shell alive
        first.transport.close();
        await sleep(1_000);
        expect(pidAlive(opened.pid)).toBe(true); // it did not go with the window

        const second = await window();
        expect(second.client.terminals().list().map((t) => t.id)).toContain(opened.id);
        await until('its output, joined', () => /term ticking/.test(second.client.terminals().attach(opened.id)?.scrollback ?? ''), 15_000);
        expect(second.client.terminals().close(opened.id)).toBe(true);
        await until('the terminal to end', () => !pidAlive(opened.pid), 15_000);
        second.transport.close();
    }, 120_000);

    it('A WORKSPACE JUST ADDED IS NEVER REFUSED: a window writes it and starts an agent in it straight away, against the real host', async () => {
        const first = await window();
        const firstOwn = ownOver(first.client);
        const added = await mkdtemp(join(tmpdir(), 'genie-host-added-'));
        // Main's add, as its window registry writes it: registry.write over its own client (window-registry-store.ts). The add
        // is answered before the workspace is shown, so the click to start comes after it: at once, as here. (A start that
        // reaches genie-host while the write is still in flight waits for it: host-tynn-recovery.test.ts pins that race.)
        expect(await ask(firstOwn.own, 'registry.write', ['writeWorkspaces', [[{ id: 'ws', path: workspace }, { id: 'added', path: added }]]])).toMatchObject({ ok: true });
        firstOwn.dispose();
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'added', provider: 'codex', name: 'newcomer' });
        expect(await first.client.start(agent, added)).toEqual({ ok: true });
        await until('the agent to take a prompt', () => first.client.promptable(agent.id) !== null, 60_000);
        expect(first.client.refusals.has(agent.id)).toBe(false);
        expect(JSON.stringify(first.client.rowsFor(agent.id))).not.toMatch(/workspace or Tynn project link is unavailable/);
        // In the ledger BEFORE the stop. A run's processes reach it after a reading of the machine, seconds on Windows, so a ledger read now can be empty with the provider
        // running. Read as "gone", that left the provider holding this folder as its cwd (EBUSY), and its row turned up during the next test as a dead provider.
        const pids = await until('its provider in the spawn ledger', async () => { const p = await providerPids(); return p.length > 0 ? p : null; }, 90_000);
        await first.client.stop(agent.id);
        await until('its provider to leave the spawn ledger', async () => (await providerPids()).length === 0, 30_000);
        await until('its processes to be gone', () => pids.every((p) => !pidAlive(p)), 30_000);
        first.transport.close();
        await rm(added, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }, 120_000);

    it('an agent keeps running and writing while no window is connected, and the next window adopts it', async () => {
        const first = await window();
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'busy' });
        expect(await first.client.start(agent, workspace)).toEqual({ ok: true });
        await until('the agent to take a prompt', () => first.client.promptable(agent.id) !== null, 60_000);
        expect(await first.client.prompt(agent.id, 'work', 'you')).toBe(true);
        await until('streamed rows', () => first.client.rowsFor(agent.id).length > 3, 60_000);
        const pids = await until('the provider in the spawn ledger', async () => { const p = await providerPids(); return p.length > 0 ? p : null; }, 30_000);
        expect(pids.every(pidAlive)).toBe(true); // positive control: the gauge sees the provider alive

        const rowsAtCrash = first.client.rowsFor(agent.id).length;
        first.transport.close(); // the window crashed
        const bytesAtCrash = await threadBytes();
        await sleep(3_000);

        // No window: the host and the provider still run, and the agent's thread keeps growing.
        expect(pidAlive(hostProcess.pid!)).toBe(true);
        expect(pids.every(pidAlive)).toBe(true);
        expect(await threadBytes()).toBeGreaterThan(bytesAtCrash);

        const second = await window();
        expect(second.client.runOf(agent.id)).not.toBeNull();
        expect(second.client.probe(agent.id)?.running).toBe(true);
        // What happened while no window was there is in the adopted run.
        expect(second.client.rowsFor(agent.id).length).toBeGreaterThan(rowsAtCrash);

        // The graceful end: sessions stopped and verified, then the process exits and its providers are gone.
        expect(await second.client.shutdown()).toBe(true);
        await until('the host to exit', () => hostProcess.exitCode !== null, 30_000);
        await until('the provider to be gone', () => pids.every((p) => !pidAlive(p)), 15_000);
        expect(await readText(join(home, 'runtime', 'host.json'))).toBeNull();
    }, 240_000);
});
