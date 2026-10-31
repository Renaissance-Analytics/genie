import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { hostingTools, type ServiceExec } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * `services exec` (the owner's decision, 2026-10-16: "env + services exec … ONLY let through Genie-managed service. DO
 * NOT EXPOSE KEYS"). moic needed `php artisan migrate:fresh --seed` against its own database: its shell had no DB_*,
 * `services env` masks the password, and it ended up reading Genie's services.json. Now an agent asks Genie to run a
 * one-off command in its workspace WITH the workspace's service variables — the current ones, so an engine changed a
 * minute ago is reached — and gets the exit code and the output back with every credential masked, even one the
 * command printed. The person approves the command first, as a terminal's. Values invented; names RFC 2606.
 */

const pty: PtyPort = {
    open: () => ({ id: 't', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};
function fakeDocker(): DockerRunner {
    const containers = new Map<string, string>();
    return async (args) => {
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
}

let dir: string;
let services: ComposedServices;
let ran: Array<{ command: string; cwd: string; env: Readonly<Record<string, string>> }>;
let printed: (env: Readonly<Record<string, string>>) => string;
let approvals: string[];
let decision: 'allowed' | 'denied';
let tools: Registration[];
const caller: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: '' } as Caller;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-svc-exec-'));
    await mkdir(join(dir, 'example'), { recursive: true });
    await writeFile(join(dir, 'example', 'project.json'), `${JSON.stringify({ name: 'example', repos: [] })}\n`, 'utf8');
    (caller as { workspacePath: string }).workspacePath = join(dir, 'example');
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: fakeDocker(), portFree: async () => true, workspaces: () => [{ id: 'example', path: join(dir, 'example') }] });
    ran = [];
    approvals = [];
    decision = 'allowed';
    printed = () => 'Migrated.\n';
    const exec: ServiceExec = async (input) => { ran.push(input); return { exitCode: 0, output: printed(input.env), timedOut: false }; };
    tools = hostingTools({ resolveCaller: (id) => (id === 't-example' ? caller : null), approve: async (_c, action, detail) => { approvals.push(`${action}: ${detail}`); return decision; }, services, exec });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>) {
    const reg = tools.find((t) => t.definition.name === 'services')!;
    const r = await reg.handler({ ...args, terminalId: 't-example' } as never, { server: 'genie', tool: 'services', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

describe('services exec', () => {
    it('runs the command in the workspace with its CURRENT service variables, after the person approves it', async () => {
        await services.engines.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'example' }, consent: true, workspaceId: 'example' });
        const r = await call({ action: 'exec', command: 'php artisan migrate:fresh --seed' });
        expect(r.isError).toBe(false);
        expect(approvals).toEqual(['services.exec: php artisan migrate:fresh --seed']);
        expect(ran).toHaveLength(1);
        expect(ran[0]!.command).toBe('php artisan migrate:fresh --seed');
        expect(ran[0]!.cwd).toBe(join(dir, 'example'));
        // Exactly the workspace's service env — what its terminals get from the engines, nothing else Genie holds.
        expect(ran[0]!.env).toEqual(services.engines.envFor('example'));
        expect(ran[0]!.env.DB_PASSWORD).toBeTruthy();
        expect(r.json).toMatchObject({ ok: true, exitCode: 0, output: 'Migrated.\n', timedOut: false });
    });

    it('masks every credential in what it returns, even one the command printed — and only those (CONTROL: the rest reads as printed)', async () => {
        await services.engines.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'example' }, consent: true, workspaceId: 'example' });
        printed = (env) => `password=${env.DB_PASSWORD}\nurl=${env.DATABASE_URL}\nport=${env.DB_PORT}\n`;
        const env = services.engines.envFor('example');
        const r = await call({ action: 'exec', command: 'php -r "print getenv(\'DB_PASSWORD\');"' });
        expect(r.text).not.toContain(env.DB_PASSWORD!);
        expect((r.json.output as string).match(/\*{8}/g)).toHaveLength(2);
        expect(r.json.output).toContain(`port=${env.DB_PORT}`);
    });

    it('a command the person DENIES is not run', async () => {
        decision = 'denied';
        const r = await call({ action: 'exec', command: 'php artisan migrate' });
        expect(r.isError).toBe(true);
        expect(ran).toEqual([]);
    });

    it('a folder outside the workspace is refused, and nothing runs', async () => {
        const r = await call({ action: 'exec', command: 'ls', cwd: dir });
        expect(r.isError).toBe(true);
        expect(ran).toEqual([]);
        expect(approvals).toEqual([]);
    });
});

/*
 * genie#1354: the folder an agent names for `exec` goes through the SHARED confinement (workspace-confine.ts): a link
 * inside the workspace that points out of it is refused before anything is asked or run, and a folder whose name only
 * starts with two dots is inside the workspace (the old check refused `..build`).
 */
describe('services exec — the folder, after links (genie#1354)', () => {
    it('a directory link inside the workspace that points OUT is refused; nothing is asked, nothing runs', async () => {
        await mkdir(join(dir, 'outside'), { recursive: true });
        await symlink(join(dir, 'outside'), join(dir, 'example', 'escape'), 'junction');
        const r = await call({ action: 'exec', command: 'ls', cwd: 'escape' });
        expect(r.isError).toBe(true);
        expect(ran).toEqual([]);
        expect(approvals).toEqual([]);
    });

    it('a folder named `..build` is inside the workspace, and the command runs there', async () => {
        await mkdir(join(dir, 'example', '..build'), { recursive: true });
        const r = await call({ action: 'exec', command: 'ls', cwd: '..build' });
        expect(r.isError).toBe(false);
        expect(ran.map((x) => x.cwd)).toEqual([join(dir, 'example', '..build')]);
    });
});

/*
 * genie#1360: the MCP call's AbortSignal and progress reach both waits `services exec` has — the person's approval and
 * the command itself — so a client that goes away withdraws the approval or stops the command, and a client still
 * there hears what it is waiting for.
 */
describe('services exec — the MCP call goes away (genie#1360)', () => {
    it('hands the call’s signal and progress to the approval and to the command', async () => {
        const gone = new AbortController();
        const progress = () => {};
        let approvedWith: unknown;
        let execWith: Parameters<ServiceExec>[0] | undefined;
        const own = hostingTools({
            resolveCaller: (id) => (id === 't-example' ? caller : null),
            approve: async (_c, _a, _d, call) => { approvedWith = call; return 'allowed'; },
            services,
            exec: async (input) => { execWith = input; return { exitCode: 0, output: '', timedOut: false }; },
        });
        const reg = own.find((t) => t.definition.name === 'services')!;
        await reg.handler({ action: 'exec', command: 'php artisan migrate', terminalId: 't-example' } as never, { server: 'genie', tool: 'services', headers: {}, signal: gone.signal, progress });
        expect((approvedWith as { signal?: AbortSignal }).signal).toBe(gone.signal);
        expect(execWith?.signal).toBe(gone.signal);
        expect(execWith?.progress).toBe(progress);
    });

    it('a command stopped because the client went away says so, and is not reported as a timeout', async () => {
        const gone = new AbortController();
        const own = hostingTools({
            resolveCaller: (id) => (id === 't-example' ? caller : null),
            approve: async () => 'allowed',
            services,
            exec: async (input) => { gone.abort(); return { exitCode: null, output: 'half', timedOut: false, aborted: input.signal?.aborted === true }; },
        });
        const reg = own.find((t) => t.definition.name === 'services')!;
        const r = await reg.handler({ action: 'exec', command: 'php artisan migrate', terminalId: 't-example' } as never, { server: 'genie', tool: 'services', headers: {}, signal: gone.signal });
        expect(r.isError).toBe(true);
        expect(JSON.parse(r.text).error).toMatch(/client disconnected/);
    });
});
