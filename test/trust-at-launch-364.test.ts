import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, type DriverFor, type GenieInstructionFiles } from '../src/main/session-host.js';
import { TakeOverHost } from '../src/main/take-over-host.js';
import { TakeOverService } from '../src/main/take-over-service.js';

/*
 * NOTHING RUNS IN A WORKSPACE THE PERSON HAS NOT TRUSTED WITHOUT READING THE VERDICT WHEN IT RUNS (Tynn #364). Trust is given
 * once and is durable (Tynn #618); these checks read the verdict as it is at the moment they act, each time, and add no
 * prompt of their own: the one place to say yes is the workspace's Trust step.
 */

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

const FILES: GenieInstructionFiles = { promptFile: join('/genie', 'prompt.md'), pluginDir: join('/genie', 'plugin'), promptText: 'genie words' };
const GENIE: McpServer = { type: 'http', name: 'genie', url: 'http://127.0.0.1:12345/mcp', headers: [] };

let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'trust-at-launch-')); });
afterEach(async () => { for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); } await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

function sessionFixture(input: { provider: 'claude' | 'codex'; untrustedFilesFor: () => Promise<GenieInstructionFiles | null>; untrustedNow: () => boolean; prepare?: Promise<readonly McpServer[]> }) {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: input.provider, name: 'atlas' });
    const created: Array<{ untrusted: GenieInstructionFiles | undefined }> = [];
    const started: number[] = [];
    let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
    const tree: ProcessTree = { snapshot: () => [...processes], killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; } };
    const driverFor: DriverFor = (agent, _cwd, _resume, extras) => {
        created.push({ untrusted: extras?.untrusted });
        return () => {
            const pid = process.pid + 1_000_000 + created.length;
            return { start: () => { started.push(pid); processes.push({ pid, ppid: process.pid, started: 3, name: `${agent.provider}-fixture` }); }, prompt: () => {}, kill: () => { processes = processes.filter((p) => p.pid !== pid); }, cliSessionId: null, ready: Promise.resolve() } as never;
        };
    };
    const host = new SessionHost({
        userData: dir, driverFor, processTree: tree, stopGraceMs: 0, mcpServersFor: () => [GENIE],
        untrustedFilesFor: input.untrustedFilesFor, untrustedNow: input.untrustedNow,
        ...(input.prepare ? { prepareMcpServers: () => input.prepare! } : {}),
        lifecycle: { spawned: () => {}, ended: () => {}, straggler: () => {} },
    });
    hosts.push(host);
    return { host, record, created, started };
}

describe('an agent start reads the verdict again just before it spawns (item 3)', () => {
    it('trusted when preparation began, untrusted by the time it ended: refused, nothing is created or spawned, and it says why', async () => {
        const prepare = deferred<readonly McpServer[]>();
        let untrusted = false;
        const t = sessionFixture({ provider: 'claude', untrustedFilesFor: async () => (untrusted ? FILES : null), untrustedNow: () => untrusted, prepare: prepare.promise });
        expect(t.host.start(t.record, dir)).toEqual({ ok: true });
        // The person's Untrust lands while the MCP servers are still being prepared over the network.
        await new Promise((r) => setTimeout(r, 20));
        untrusted = true;
        prepare.resolve([GENIE]);
        await vi.waitFor(() => expect(t.host.probe(t.record.id)?.failure).toBeTruthy());
        expect(t.created).toEqual([]);
        expect(t.started).toEqual([]);
        expect(String(t.host.probe(t.record.id)?.failure)).toMatch(/trust/i);
    });

    it('CONTROL: the verdict did not move during preparation: it starts as trusted', async () => {
        const prepare = deferred<readonly McpServer[]>();
        const t = sessionFixture({ provider: 'claude', untrustedFilesFor: async () => null, untrustedNow: () => false, prepare: prepare.promise });
        t.host.start(t.record, dir);
        await new Promise((r) => setTimeout(r, 20));
        prepare.resolve([GENIE]);
        await vi.waitFor(() => expect(t.started).toHaveLength(1));
        expect(t.created[0]?.untrusted).toBeUndefined();
    });

    it('CONTROL: untrusted all along (Claude): it starts restricted, as before', async () => {
        const prepare = deferred<readonly McpServer[]>();
        const t = sessionFixture({ provider: 'claude', untrustedFilesFor: async () => FILES, untrustedNow: () => true, prepare: prepare.promise });
        t.host.start(t.record, dir);
        prepare.resolve([GENIE]);
        await vi.waitFor(() => expect(t.started).toHaveLength(1));
        expect(t.created[0]?.untrusted).toEqual(FILES);
    });
});

describe('a Codex agent in a workspace not trusted is refused (item 2)', () => {
    it('untrusted: no Codex is created or spawned, and the reason names the trust step', async () => {
        const t = sessionFixture({ provider: 'codex', untrustedFilesFor: async () => FILES, untrustedNow: () => true });
        expect(t.host.start(t.record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(t.host.probe(t.record.id)?.failure).toBeTruthy());
        expect(t.created).toEqual([]);
        expect(t.started).toEqual([]);
        expect(String(t.host.probe(t.record.id)?.failure)).toMatch(/Trust this workspace/);
    });

    it('CONTROL: trusted, Codex starts', async () => {
        const t = sessionFixture({ provider: 'codex', untrustedFilesFor: async () => null, untrustedNow: () => false });
        t.host.start(t.record, dir);
        await vi.waitFor(() => expect(t.started).toHaveLength(1));
    });
});

describe('Take Over reads the verdict at each click (item 1)', () => {
    const atlas = { id: 'agent_atlas', name: 'atlas', provider: 'claude', workspaceId: 'acme' } as unknown as AgentRecord;
    function rig(untrustedNow: () => boolean) {
        const opened: Array<{ cwd: string; command: string }> = [];
        const host = new TakeOverHost({
            terminals: { open: (o: { cwd: string; command: string }) => { opened.push(o); return { id: `term_${opened.length}`, pid: 1, shell: o.command, scrollback: '' }; }, close: () => true, onData: () => () => {}, onExit: () => () => {} } as never,
            openWindow: () => {},
        });
        const service = new TakeOverService({ host, find: (id) => (id === atlas.id ? atlas : null), workspacePath: () => '/w/acme', tuiFor: () => 'claude', onChange: () => {}, untrustedNow });
        return { service, opened };
    }

    it('untrusted: refused, no terminal opens, and the reason sends the person to the workspace\'s Trust step', () => {
        const r = rig(() => true);
        const started = r.service.start(atlas.id);
        expect(started.ok).toBe(false);
        expect(started.ok === false && started.reason).toMatch(/Trust this workspace/);
        expect(r.opened).toEqual([]);
    });

    it('read at the click, not kept: refused while untrusted, and the next click after the person trusts it starts the TUI', () => {
        let untrusted = true;
        const r = rig(() => untrusted);
        expect(r.service.start(atlas.id).ok).toBe(false);
        untrusted = false;
        expect(r.service.start(atlas.id)).toEqual({ ok: true, terminalId: 'term_1', started: true });
        expect(r.opened).toHaveLength(1);
    });

    it('CONTROL: trusted, the TUI starts in the workspace', () => {
        const r = rig(() => false);
        expect(r.service.start(atlas.id)).toEqual({ ok: true, terminalId: 'term_1', started: true });
        expect(r.opened[0]).toMatchObject({ cwd: '/w/acme', command: 'claude' });
    });

    it('genie-host hands Take Over the same verdict its agents read', () => {
        const source = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        const construction = source.slice(source.indexOf('new TakeOverService({'), source.indexOf('});', source.indexOf('new TakeOverService({')));
        expect(construction).toMatch(/untrustedNow:\s*\(record\)\s*=>\s*hostUntrustedNow\(record\)/);
    });
});
