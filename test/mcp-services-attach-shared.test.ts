import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ServiceInstance } from '../src/core/services.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * `services add` ON A SHARED ENGINE THAT ALREADY EXISTS ATTACHES IT TO THE CALLER'S WORKSPACE (genie#1332, 2026-10-29).
 *
 * The fancy agent asked for the shared Mailpit Genie 2 took over from Genie 1. `add` answered `outcome: "exists"` with
 * `svc_v1_mailpit-1.30`, `active: false`, `inUse: false` — and then `use` and `start` refused that very id as "not one of
 * this workspace's services", and `env` had no MAIL_*. Genie 1 never attached that workspace to Mailpit, so the taken-over
 * engine carried no slice for it; and a Mailpit slice is only a NAME (the plus-address tag), so `#useSlice` made none.
 *
 * Genie 1's `manageService add` (tag v0.7.0-beta.342, main/mcp/dev-service-tools.ts:552) always wrote the workspace's
 * own `dev_services` entry and acquired the shared container already running: adding an engine that exists IS attaching
 * to it. Driven through the REAL composition and approval queue, Docker a fake runner that counts what it is asked.
 */

const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 1, shell: 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>([['genie-svc-mailpit-1.30', 'running']]);
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls };
}

const WS = 'fancy-like';
const ATTACHED = 'genie1-attached';
const SMTP = 38313;
const UI = 35951;
/** Genie 1's Mailpit as the take-over registers it: ONE workspace held a slice of it in Genie 1, the caller none. */
const v1Mailpit: ServiceInstance = {
    id: 'svc_v1_mailpit-1.30', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: SMTP, credentials: {}, active: true, adopted: 'v1',
    containerName: 'genie-svc-mailpit-1.30', admin: { user: '', password: 'admin-mail-secret' },
    slices: { [ATTACHED]: { identifier: 'ws_genie1_attached', password: 'attached-mail-pw', active: true } },
    publishedPorts: { smtp: SMTP, ui: UI },
};

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
let tools: Registration[];
const callers: Record<string, Caller> = {};

async function call(terminalId: string, args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'services')!;
    const r = await reg.handler({ ...args, terminalId }, { server: 'genie', tool: 'services', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 200 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-attach-shared-'));
    docker = fakeDocker();
    for (const ws of [WS, ATTACHED]) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run, portFree: async () => true,
        workspaces: () => [{ id: WS, path: join(dir, WS) }, { id: ATTACHED, path: join(dir, ATTACHED) }],
    });
    await services.engines.adoptFromV1({ instances: [v1Mailpit], record: { at: '2026-10-15T00:00:00.000Z', sawV1: true, sawDocker: true } });
    callers['t-fancy'] = { agentId: mintAgentId(), agentName: 'fancy', workspaceId: WS, workspacePath: join(dir, WS) };
    tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: (c, a, d) => services.approvals.gate(c, a, d), services });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services add on a shared engine that already exists attaches it to the calling workspace', () => {
    it('Genie 1’s Mailpit: add → exists, ATTACHED (active, in use) → env has MAIL_* with this workspace’s tag; nothing created or pulled', async () => {
        // The report's starting point: not listed, no MAIL_* (and the workspace Genie 1 had attached has them — the control).
        expect(services.engines.envFor(WS)).not.toHaveProperty('MAIL_PORT');
        expect(services.engines.envFor(ATTACHED)).toMatchObject({ MAIL_PORT: String(SMTP), GENIE_MAIL_TAG: 'ws_genie1_attached' });
        const before = await call('t-fancy', { action: 'list' });
        expect((before.json.services as Array<{ id: string }>).map((s) => s.id)).not.toContain(v1Mailpit.id);

        const pending = call('t-fancy', { action: 'add', engine: 'mailpit', version: '1.30', scope: 'shared' });
        const item = await asked();
        // The person is told the truth: nothing is pulled or created, the running engine is attached.
        expect(item.title).toContain('mailpit 1.30, shared by every workspace on this machine');
        expect(item.title).toContain('already running');
        expect(item.title).not.toContain('pulls the image');
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ ok: true, outcome: 'exists', service: { id: v1Mailpit.id, active: true, inUse: true, takenOverFromGenie1: true } });

        expect(services.engines.envFor(WS)).toMatchObject({ MAIL_MAILER: 'smtp', MAIL_PORT: String(SMTP), GENIE_MAIL_TAG: 'ws_fancy_like', MAIL_FROM_ADDRESS: 'genie+ws_fancy_like@mail.gen' });
        const env = await call('t-fancy', { action: 'env' });
        expect(env.json.variables).toMatchObject({ MAIL_PORT: String(SMTP), GENIE_MAIL_TAG: 'ws_fancy_like' });
        // The engine Genie 1 left is reused as it is: Docker was never asked to create or pull anything.
        expect(docker.calls.filter((c) => c[0] === 'create' || c[0] === 'pull' || c[0] === 'rm')).toEqual([]);
        // The workspace Genie 1 attached keeps its own slice, untouched.
        expect(services.engines.list().find((i) => i.id === v1Mailpit.id)!.slices![ATTACHED]).toEqual(v1Mailpit.slices![ATTACHED]);
    });

    it('once attached, `list` shows it and `use` and `start` accept its id; a second add attaches nothing twice', async () => {
        const pending = call('t-fancy', { action: 'add', engine: 'mailpit', version: '1.30', scope: 'shared' });
        services.approvals.resolve((await asked()).id, 'allow');
        await pending;

        const listed = await call('t-fancy', { action: 'list' });
        expect((listed.json.services as Array<Record<string, unknown>>).find((s) => s.id === v1Mailpit.id)).toMatchObject({ inUse: true, active: true });
        const use = await call('t-fancy', { action: 'use', id: v1Mailpit.id });
        expect(use.isError).toBe(false);
        expect(use.json.note).toMatch(/already uses mailpit 1.30, shared/);
        const start = await call('t-fancy', { action: 'start', id: v1Mailpit.id });
        expect(start.isError).toBe(false);
        expect(start.json).toMatchObject({ ok: true, service: { id: v1Mailpit.id } });

        const slice = services.engines.list().find((i) => i.id === v1Mailpit.id)!.slices![WS];
        const again = call('t-fancy', { action: 'add', engine: 'mailpit', version: '1.30', scope: 'shared' });
        services.approvals.resolve((await asked()).id, 'allow');
        expect((await again).json).toMatchObject({ ok: true, outcome: 'exists', service: { id: v1Mailpit.id, inUse: true } });
        expect(services.engines.list().find((i) => i.id === v1Mailpit.id)!.slices![WS]).toEqual(slice);
    });

    it('an engine Genie cannot attach a workspace to (Genie 1’s MinIO: a bucket Genie 2 cannot make) is an ERROR, never `exists` with an id `use` refuses', async () => {
        const v1Minio: ServiceInstance = {
            id: 'svc_v1_minio-latest', engine: 'minio', version: 'latest', scope: { kind: 'shared' }, publishedPort: 39000, credentials: {}, active: true, adopted: 'v1',
            containerName: 'genie-svc-minio-latest', admin: { user: 'minio', password: 'admin-minio-secret' },
            slices: { [ATTACHED]: { identifier: 'ws_genie1_attached', password: 'attached-minio-pw', bucket: 'ws-genie1-attached', active: true } },
            publishedPorts: { s3: 39000 },
        };
        await services.engines.adoptFromV1({ instances: [v1Minio], record: { at: '2026-10-15T00:00:00.000Z', sawV1: true, sawDocker: true } });
        const pending = call('t-fancy', { action: 'add', engine: 'minio', version: 'latest', scope: 'shared' });
        services.approvals.resolve((await asked()).id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/serves only the workspaces Genie 1 gave it; Genie cannot attach this workspace to it/);
        expect(r.json).not.toHaveProperty('outcome');
        expect(services.engines.envFor(WS)).not.toHaveProperty('AWS_ENDPOINT');
    });
});
