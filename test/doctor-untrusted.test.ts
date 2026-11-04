import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, PermissionRequestLike, SessionDriverFactory } from '../src/core/session.js';
import { DoctorRun } from '../src/main/doctor-run.js';
import type { DriverFor, GenieInstructionFiles } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';

/**
 * A DOCTOR TRIAL OF THE TRUST GATE (the owner: "trust gate can use a dev build running in doctor mode"). Doctor can start
 * its one agent as an untrusted workspace's agent is started, on the person's real login, and see and answer a shell call
 * it parks. Doctor only: nothing else in Genie can reach this.
 */
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const shellAsk: PermissionRequestLike = {
    toolCall: { title: 'git status', name: 'Bash', rawInput: { command: 'git status' } },
    options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
};
let home: string;
let folder: string;
let run: DoctorRun;
const kai = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'kai' });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-doctor-untrusted-'));
    folder = join(home, 'projects', 'acme');
    await mkdir(folder, { recursive: true });
    const store = new Store(home);
    await store.writeWorkspaces([{ id: 'ws', path: folder }]);
    await store.writeAgents([kai]);
});
afterEach(async () => {
    await run.stop();
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function doctor() {
    const launches: Array<GenieInstructionFiles | undefined> = [];
    let events: DriverEvents = {};
    const driverFor: DriverFor = (_record, _cwd, _resume, extras) => {
        launches.push(extras?.untrusted);
        return ((options: { events: DriverEvents }) => {
            events = options.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        }) as unknown as SessionDriverFactory;
    };
    run = new DoctorRun({ genieHome: home, besideHome: join(home, 'doctor-beside'), genieRunning: () => ({ running: false, pid: null, agents: null }) as never, prepareOsaHome: async () => {}, driverFor, processTree: tree });
    const call = async (name: string, args: Record<string, unknown>) => {
        const tool = run.tools().find((t) => t.definition.name === name);
        if (!tool) throw new Error(`no tool ${name}`);
        const r = await tool.handler(args as never, { server: 'genie', tool: name, headers: {} });
        return { isError: r.isError, json: JSON.parse(r.text) as Record<string, any> };
    };
    const settled = async () => { for (let i = 0; i < 20 && launches.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25)); await new Promise((r) => setTimeout(r, 25)); };
    return { call, launches, settled, ask: () => events.onRequestPermission!(shellAsk) };
}

describe('startAgent, as an untrusted workspace starts it', () => {
    it("with untrusted: Genie's own files, outside the workspace", async () => {
        const d = doctor();
        expect((await d.call('startAgent', { workspace: 'ws', agent: 'kai', untrusted: true })).isError).toBe(false);
        await d.settled();
        const files = d.launches[0];
        expect(files).toBeDefined();
        expect(existsSync(files!.promptFile)).toBe(true);
        expect(files!.promptFile.startsWith(folder)).toBe(false);
    });

    it('CONTROL: without it, as doctor always has', async () => {
        const d = doctor();
        await d.call('startAgent', { workspace: 'ws', agent: 'kai' });
        await d.settled();
        expect(d.launches).toEqual([undefined]);
    });
});

describe('a shell call while untrusted', () => {
    it('parks, doctor sees it, and its answer is what the agent gets', async () => {
        const d = doctor();
        await d.call('startAgent', { workspace: 'ws', agent: 'kai', untrusted: true });
        await d.settled();
        let answer: unknown = null;
        void d.ask().then((a) => { answer = a; });
        await new Promise((r) => setTimeout(r, 25));
        expect(answer).toBeNull();
        expect((await d.call('agentWaiting', {})).json).toMatchObject({ ok: true, waiting: { what: expect.stringContaining('git status'), options: ['allow_once', 'reject_once'] } });
        expect((await d.call('answerApproval', { option: 'reject_once' })).isError).toBe(false);
        await new Promise((r) => setTimeout(r, 25));
        expect(answer).toEqual({ outcome: 'selected', optionId: 'reject_once' });
        expect((await d.call('agentWaiting', {})).json).toMatchObject({ ok: true, waiting: null });
    });

    it('CONTROL: trusted, the same call is allowed at once and nothing waits', async () => {
        const d = doctor();
        await d.call('startAgent', { workspace: 'ws', agent: 'kai' });
        await d.settled();
        expect(await d.ask()).toEqual({ outcome: 'selected', optionId: 'allow_once' });
        expect((await d.call('agentWaiting', {})).json).toMatchObject({ ok: true, waiting: null });
    });
});

describe('it stays in doctor', () => {
    it('only doctor-run.ts names the option (reads the source)', () => {
        for (const file of ['main.ts', 'compose.ts', 'host-api.ts', 'mcp-host-tools.ts', 'genie-host.ts']) {
            const source = readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8');
            expect(source, file).not.toMatch(/agentWaiting|untrusted: true/);
        }
    });
});
