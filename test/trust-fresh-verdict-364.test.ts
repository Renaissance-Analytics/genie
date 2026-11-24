import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { gitTreeStatus } from '../src/main/git-ports.js';
import { setGitReadPolicy } from '../src/main/git-read-policy.js';
import { ownTrust, type OwnTrust } from '../src/main/hosting-trust.js';
import { nodeEnvelopeFs } from '../src/main/envelope-sites-host.js';
import { playwrightTools } from '../src/main/mcp-tools-playwright.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { PLAYWRIGHT_NOTE_ENV, PlaywrightHost } from '../src/main/playwright-host.js';
import type { PlaywrightBrowsersFs } from '../src/main/playwright-browsers.js';
import type { PlaywrightServerPorts } from '../src/main/playwright-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE SHORT WINDOW BEFORE A FRESH VERDICT (Tynn #364). A workspace in which nothing would run is trusted without the
 * person being asked. When a file arrives that would run something (a `.git/config` key, an `.mcp.json`), the verdict
 * says so only once it is read again: on Windows nothing in a workspace is watched, so that is the slow pass, up to 15 s
 * (trust-watch.ts `TRUST_PASS_MS`). Until then the verdict kept says "trusted", and whatever read it acted on it: git ran
 * the new key, a running session took more work, Playwright installed what the lockfile pinned.
 *
 * Each of those now reads the verdict when it acts. The person's own yes is the record's, and only their Untrust ends it
 * (Tynn #618), so it stands as it is, read at once; anything else is read again before it acts. One test per path shows
 * the stale window (the verdict kept says trusted, the files say otherwise), and its control.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- git reads

describe('git reads, in a workspace trusted only because nothing would run', () => {
    let root: string;
    let repo: string;
    let mark: string;
    let own: OwnTrust | null = null;
    const book = { carried: [] as string[], workspaces: {} as Record<string, string> };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const tool = () => {
        const file = join(root, 'tool.sh');
        writeFileSync(file, `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\nexit 0\n`);
        chmodSync(file, 0o755);
        return file.replace(/\\/g, '/');
    };

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'fresh-git-364-'));
        mark = join(root, 'mark.txt');
        repo = join(root, 'acme');
        mkdirSync(repo);
        git('init', '-q');
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        git('add', '.');
        git('commit', '-q', '-m', 'first');
        writeFileSync(join(repo, 'a.txt'), 'two\n');
        book.carried = [];
        book.workspaces = {};
        own = ownTrust({
            workspaces: () => [{ id: 'acme', path: repo }],
            envelopeSites: { trustRecord: () => book, recordWorkspace: async (id, hash) => { book.workspaces[id] = hash; }, forgetWorkspaceTrust: async (id) => { delete book.workspaces[id]; }, approveSites: async () => {} },
            readText: nodeEnvelopeFs().readText,
            watchFolders: false,
            everyMs: 1_000_000,
        });
        await vi.waitFor(() => { expect(own!.api.view('acme')).not.toBeNull(); }, { timeout: 10_000, interval: 10 });
        expect(own.api.view('acme')).toMatchObject({ trusted: true });
    });
    afterEach(async () => {
        await own?.close();
        own = null;
        setGitReadPolicy(null);
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it('a key arrives that could run something: before the verdict is read again, git runs nothing', async () => {
        git('config', 'core.fsmonitor', tool());
        // The stale window: the verdict kept still says trusted.
        expect(own!.api.view('acme')).toMatchObject({ trusted: true });
        expect(await gitTreeStatus(repo)).toEqual({});
        expect(existsSync(mark)).toBe(false);
    });

    it('CONTROL: the person trusts it, and the same key runs, as git does (their yes is read at once)', async () => {
        git('config', 'core.fsmonitor', tool());
        await own!.api.trust('acme');
        await gitTreeStatus(repo);
        expect(existsSync(mark)).toBe(true);
    });

    it('CONTROL: a plain repository is read as ever', async () => {
        expect(await gitTreeStatus(repo)).toMatchObject({ 'a.txt': 'modified' });
    });

    it('the api reads the verdict now: the yes of the record at once, anything else read again', async () => {
        writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'node', args: ['x.js'] } } }));
        expect(own!.api.view('acme')).toMatchObject({ trusted: true });
        expect(await own!.api.current('acme')).toBe(false);
        expect(own!.api.durable('acme')).toBe(false);
        await own!.api.trust('acme');
        expect(own!.api.durable('acme')).toBe(true);
        expect(await own!.api.current('acme')).toBe(true);
    });
});

// ---------------------------------------------------------------- a running session taking more work

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
interface Fake { events: DriverEvents; prompts: string[] }

describe('work reaching a session launched trusted', () => {
    let dir: string;
    let stopAll: () => Promise<void> = async () => {};
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fresh-work-364-')); });
    afterEach(async () => {
        await stopAll();
        stopAll = async () => {};
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });
    const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

    /** The verdict kept says trusted throughout (`untrustedNow` false). `fresh` is what a read made now finds. */
    function rig(fresh: { trusted: boolean }, durable = false) {
        const record: AgentRecord = agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'atlas' });
        const fakes: Fake[] = [];
        let reads = 0;
        const driverFor: DriverFor = () => {
            const factory: SessionDriverFactory = (o) => {
                const fake: Fake = { events: o.events, prompts: [] };
                fakes.push(fake);
                return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(String(content)); }, kill: () => {}, cancel: () => {}, cliSessionId: null };
            };
            return factory;
        };
        const host = new SessionHost({
            userData: dir, driverFor, processTree: noProcessTree, stopGraceMs: 0,
            untrustedFilesFor: async () => null,
            untrustedNow: () => false,
            verdictNow: { durable: () => durable, read: async () => { reads += 1; await sleep(5); return fresh.trusted; } },
        } as ConstructorParameters<typeof SessionHost>[0]);
        stopAll = async () => { host.stopAll(); await host.settled(); };
        return { host, record, fakes, reads: () => reads, endTurn: () => fakes.at(-1)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
    }
    const settle = async () => { await flush(); await sleep(30); await flush(); };

    it('a prompt, while a fresh read says untrusted: not handed to the session', async () => {
        const t = rig({ trusted: false });
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await settle();
        expect(t.reads()).toBeGreaterThan(0);
        expect(t.fakes[0]!.prompts).toEqual([]);
        expect(t.host.workWaiting(t.record.id)).toBe(true);
    });

    it('mail, while a fresh read says untrusted: not handed to the session', async () => {
        const t = rig({ trusted: false });
        t.host.start(t.record, dir);
        await flush();
        t.host.deliver(t.record.id, 'you have mail', 'genie');
        await settle();
        expect(t.fakes[0]!.prompts).toEqual([]);
    });

    it('a flow, while a fresh read says untrusted: not handed to the session', async () => {
        const t = rig({ trusted: false });
        t.host.start(t.record, dir);
        await flush();
        expect(t.host.deliverFlowPrompt(t.record.id, 'from a flow', 'flow: nightly', null)).not.toBeNull();
        await settle();
        expect(t.fakes[0]!.prompts).toEqual([]);
    });

    it('CONTROL: the fresh read says trusted, and the work goes as written', async () => {
        const t = rig({ trusted: true });
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await settle();
        expect(t.reads()).toBe(1);
        expect(t.fakes[0]!.prompts).toEqual(['work']);
    });

    it('each new piece of work reads again: a read covers the work that was waiting for it, not what comes after', async () => {
        const fresh = { trusted: true };
        const t = rig(fresh);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await settle();
        expect(t.fakes[0]!.prompts).toEqual(['work']);
        t.endTurn();
        await flush();
        fresh.trusted = false;
        t.host.prompt(t.record.id, 'more', 'you');
        await settle();
        expect(t.reads()).toBe(2);
        expect(t.fakes[0]!.prompts).toEqual(['work']);
    });

    it("CONTROL: the person's own yes stands as it is: no read, the work goes at once", async () => {
        const t = rig({ trusted: false }, true);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.reads()).toBe(0);
        expect(t.fakes[0]!.prompts).toEqual(['work']);
    });
});

// ---------------------------------------------------------------- the Playwright install

const TC = join('/data', 'genie2-toolchain');
const memoryFs = (files: Record<string, string>): PlaywrightBrowsersFs => ({
    exists: (p) => p in files, list: () => [], mkdirp: () => {}, writeText: () => {}, writeBytes: () => {}, rename: () => {}, removeTree: () => {},
    readText: (p) => files[p.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')] ?? null, size: () => 0,
});
const serverPorts = (): PlaywrightServerPorts => ({
    supervisor: { start: (spec) => ({ id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }), stop: () => true, status: (id) => ({ id, workspaceId: 'w', name: 'n', state: 'stopped', pid: 1, exitCode: null, restarts: 0, since: 0 }) },
    workspaceId: 'genie', cwd: TC, cliDir: (v) => join(TC, 'playwright', 'cli', v), allocatePort: () => 3001, mintToken: () => 'z'.repeat(40), now: () => 1, connections: async () => 0, idleMs: 600_000,
});
const lock = JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.62.1' } } });

describe('the Playwright install a workspace starts', () => {
    function hostOver(freshTrusted: boolean) {
        const asked: string[] = [];
        const host = new PlaywrightHost({
            toolchainDir: TC, server: serverPorts(), workspacePath: () => '/work/app', optIn: () => false, fs: memoryFs({ '/work/app/package-lock.json': lock }), platform: 'linux', link: () => {},
            installer: { ensure: (v) => { asked.push(v); return true; }, installing: () => asked },
            // The verdict kept says trusted; a read made now finds `freshTrusted`.
            trusted: () => true,
            trustedNow: async () => freshTrusted,
        } as ConstructorParameters<typeof PlaywrightHost>[0]);
        return { host, asked };
    }

    it('installs nothing while a fresh read says untrusted', async () => {
        const { host, asked } = hostOver(false);
        const env = host.envFor('ws');
        await sleep(10);
        expect(asked).toEqual([]);
        expect(env[PLAYWRIGHT_NOTE_ENV]).toMatch(/1\.62\.1/);
    });

    it('CONTROL: the fresh read says trusted, and it is installed', async () => {
        const { host, asked } = hostOver(true);
        host.envFor('ws');
        await sleep(10);
        expect(asked).toEqual(['1.62.1']);
    });
});

describe("an agent's `playwright install`", () => {
    async function ask(trusted: () => boolean | Promise<boolean>) {
        const installs: string[] = [];
        const caller = { agentId: 'a1', agentName: 'atlas', workspaceId: 'ws', workspacePath: '/work/app' } as unknown as Caller;
        const [tool] = playwrightTools({
            resolveCaller: () => caller,
            port: { status: () => ({ stable: '1.65.1', installed: [], browsersPath: null, project: null, installing: [], autoInstall: true }), ready: () => [], held: () => [], install: async (version, browsers) => { installs.push(version); return { kind: 'installed', version, browsers }; } },
            approve: async () => 'allowed',
            trusted: trusted as never,
        });
        const out = JSON.parse((await tool!.handler({ action: 'install', version: '1.62.1' } as never, { headers: { 'genie-session': 's' } } as never)).text) as { ok: boolean; error?: string };
        return { out, installs };
    }

    it('reads the verdict now: a fresh read that says untrusted installs nothing', async () => {
        const { out, installs } = await ask(async () => false);
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/trust/i);
        expect(installs).toEqual([]);
    });

    it('CONTROL: a fresh read that says trusted installs', async () => {
        const { out, installs } = await ask(async () => true);
        expect(out.ok).toBe(true);
        expect(installs).toEqual(['1.62.1']);
    });
});

// ---------------------------------------------------------------- the host reads them so

describe("genie-host wires each to the verdict read now", () => {
    const host = readFileSync(join(__dirname, '..', 'src', 'main', 'genie-host.ts'), 'utf8');
    const deps = readFileSync(join(__dirname, '..', 'src', 'main', 'genie-tool-deps.ts'), 'utf8');
    it('the sessions, the Playwright host and the agents\' playwright tool', () => {
        expect(host).toMatch(/verdictNow:\s*\{/);
        expect(host).toMatch(/trustedNow:\s*\(workspaceId\)\s*=>\s*hostTrustedNow\(workspaceId\)/);
        expect(host).toMatch(/workspaceTrustedNow:\s*\(workspaceId\)\s*=>\s*hostTrustedNow\(workspaceId\)/);
        expect(deps).toMatch(/trusted:\s*p\.workspaceTrustedNow \?\? p\.workspaceTrusted/);
    });
});
