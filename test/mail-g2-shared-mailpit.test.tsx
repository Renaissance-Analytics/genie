import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceFormDefaults, validateServiceForm } from '../src/core/forms.js';
import { mintAgentId } from '../src/core/identity.js';
import { containerPlan, SERVICE_CATALOG, type ServiceInstance } from '../src/core/services.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import { runtimeDir } from '../src/main/paths.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { AddServiceForm } from '../src/renderer/components/AddForms.js';

/**
 * GENIE MAIL G2 (Tynn story #488, spec .ai/plans/specs/genie-mail.md): ONE shared Mailpit, owned by the host. Genie Mail at
 * mail.gen is one app for every workspace, so a NEW per-workspace Mailpit is refused, with the reason, and asking for
 * Mailpit is answered with the shared one. A dedicated Mailpit already on the machine keeps running and listing: its mail
 * is read as its own source (decision 2, approved 2026-11-07: no migration).
 *
 * And G1's finding 6 (genie#1712): Mailpit's send API records an UNVERIFIED Basic username as a message's Username and
 * tag. So Genie's Mailpit gets its own send-API credential (MP_SEND_API_AUTH), held by Genie alone: an unverified sender
 * can no longer claim a workspace's username. (Routing by username or tag alone is G4's to refuse.)
 */

const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 1, shell: 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>([['genie-example-old-mailpit-1.30', 'exited']]);
    const run: DockerRunner = async (args) => {
        calls.push(args);
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
    const creates = () => calls.filter((c) => c[0] === 'create');
    return { run, calls, creates };
}

const WS = 'example-new';
const OLD = 'example-old';
/** A dedicated Mailpit Genie 2 created before G2, as services.json holds it. */
const oldMailpit: ServiceInstance = {
    id: 'svc_old_mailpit', engine: 'mailpit', version: '1.30', scope: { kind: 'dedicated', workspaceId: OLD }, publishedPort: 41025,
    credentials: { user: 'genie', password: 'old-mailpit-pw', database: OLD }, active: true, publishedPorts: { ui: 48025 },
};

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
let tools: Registration[];
const callers: Record<string, Caller> = {};

async function call(args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'services')!;
    const r = await reg.handler({ ...args, terminalId: 't-new' }, { server: 'genie', tool: 'services', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}
async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 200 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mail-g2-'));
    docker = fakeDocker();
    for (const ws of [WS, OLD]) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    await mkdir(runtimeDir(dir), { recursive: true });
    await writeFile(join(runtimeDir(dir), 'services.json'), JSON.stringify({ instances: [oldMailpit] }), 'utf8');
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run, portFree: async () => true,
        workspaces: () => [{ id: WS, path: join(dir, WS) }, { id: OLD, path: join(dir, OLD) }],
    });
    callers['t-new'] = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: WS, workspacePath: join(dir, WS) };
    tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: (c, a, d) => services.approvals.gate(c, a, d), services });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('one shared Mailpit: a new per-workspace one is refused, with the reason', () => {
    it('the catalog: Mailpit is shared for new adds, and says why; the form refuses a dedicated one (control: shared)', () => {
        const mailpit = SERVICE_CATALOG.find((d) => d.engine === 'mailpit')!;
        expect(mailpit.sharing).toBe('shared-only');
        expect(mailpit.sharedBecause).toMatch(/Genie Mail/);
        const dedicated = validateServiceForm({ workspaceId: WS, engine: 'mailpit', major: '1.30', scope: 'dedicated' });
        expect(dedicated).toEqual([{ field: 'scope', message: expect.stringMatching(/mailpit is a shared service[\s\S]*Genie Mail/) }]);
        expect(validateServiceForm({ workspaceId: WS, engine: 'mailpit', major: '1.30', scope: 'shared' })).toEqual([]);
    });

    it('the registry refuses a new dedicated Mailpit before anything is pulled or created', async () => {
        await expect(services.engines.add({ engine: 'mailpit', major: '1.30', scope: { kind: 'dedicated', workspaceId: WS }, consent: true, workspaceId: WS })).rejects.toThrow(/mailpit is a shared service[\s\S]*Genie Mail/);
        expect(docker.creates()).toEqual([]);
    });

    it('an agent\'s `services add mailpit` is answered with THE shared Mailpit, after the person approves it as shared', async () => {
        const pending = call({ action: 'add', engine: 'mailpit', version: '1.30' });
        const item = await asked();
        expect(item.title).toContain('mailpit 1.30, shared by every workspace on this machine');
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json.service).toMatchObject({ engine: 'mailpit', scope: 'shared', active: true });
        expect(docker.creates().map((c) => c[2])).toEqual(['genie-shared-mailpit-1.30']);
        // A second ask (another agent, the same workspace) gets the same one: nothing created twice.
        const again = call({ action: 'add', engine: 'mailpit', version: '1.30' });
        services.approvals.resolve((await asked()).id, 'allow');
        expect((await again).json).toMatchObject({ outcome: 'exists', service: { id: r.json.service.id } });
        expect(docker.creates()).toHaveLength(1);
    });

    it('an agent asking for a DEDICATED Mailpit is refused with the reason, and the person is not asked', async () => {
        const r = await call({ action: 'add', engine: 'mailpit', version: '1.30', scope: 'dedicated' });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/mailpit is a shared service[\s\S]*Genie Mail/);
        expect(services.approvals.deckItems()).toEqual([]);
        expect(docker.creates()).toEqual([]);
    });

    it('the Add engine form offers Mailpit shared only, and says why (control: Postgres keeps both)', () => {
        const form = (engine: string) => renderToStaticMarkup(<AddServiceForm defaults={{ ...serviceFormDefaults({ workspaceId: WS }), engine, scope: 'dedicated' }} problems={[]} consent={null} onSubmit={() => {}} onCancel={() => {}} />);
        const radio = (html: string, value: string) => new RegExp(`<input[^>]*value="${value}"[^>]*>`).exec(html)?.[0] ?? '';
        const mail = form('mailpit');
        expect(radio(mail, 'dedicated')).toMatch(/disabled=""/);
        expect(radio(mail, 'dedicated')).not.toMatch(/checked=""/);
        expect(radio(mail, 'shared')).toMatch(/checked=""/);
        expect(mail).toMatch(/data-shared-only=""[\s\S]*Genie Mail/);
        const pg = form('postgres');
        expect(radio(pg, 'dedicated')).not.toMatch(/disabled=""/);
        expect(pg).not.toContain('data-shared-only');
    });
});

describe('a dedicated Mailpit already on the machine is kept, as its own source', () => {
    it('it still lists, gives its workspace its env, and starts; its container can still be planned (an update recreates it)', async () => {
        expect(services.engines.list(OLD).map((i) => i.id)).toEqual(['svc_old_mailpit']);
        expect(services.engines.envFor(OLD)).toMatchObject({ MAIL_MAILER: 'smtp', MAIL_PORT: '41025' });
        await services.engines.start('svc_old_mailpit');
        expect(docker.calls).toContainEqual(['start', 'genie-example-old-mailpit-1.30']);
        const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'dedicated', workspaceId: OLD }, publishedPort: 41025, surfacePorts: { ui: 48025 }, credentials: oldMailpit.credentials });
        expect(plan.name).toBe('genie-example-old-mailpit-1.30');
    });
});

describe('the send API is Genie\'s alone (G1 finding 6)', () => {
    it('Genie\'s Mailpit is created with its own send-API credential, which no workspace is given', async () => {
        await services.engines.add({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, consent: true, workspaceId: WS });
        const shared = services.engines.list().find((i) => i.engine === 'mailpit' && i.scope.kind === 'shared')!;
        const create = docker.creates()[0]!;
        const env = create.flatMap((a, i) => (create[i - 1] === '-e' ? [a] : []));
        expect(env).toContain(`MP_SEND_API_AUTH=${shared.credentials.user}:${shared.credentials.password}`);
        expect(shared.credentials.password).toMatch(/\S{8,}/);
        // Not in any workspace's env: the credential is Genie's, never an app's.
        for (const ws of [WS, OLD]) expect(Object.values(services.engines.envFor(ws)).join('\n')).not.toContain(shared.credentials.password!);
    });

    it('the plan carries it for every Mailpit Genie plans, the kept dedicated one too (control: Postgres has none)', () => {
        const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: { user: 'genie', password: 'p-123456789' } });
        expect(plan.env).toMatchObject({ MP_SEND_API_AUTH: 'genie:p-123456789' });
        const kept = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'dedicated', workspaceId: OLD }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: oldMailpit.credentials });
        expect(kept.env).toMatchObject({ MP_SEND_API_AUTH: 'genie:old-mailpit-pw' });
        expect(containerPlan({ engine: 'postgres', major: '17', scope: { kind: 'shared' }, publishedPort: 1, credentials: { user: 'genie', password: 'x' } }).env).not.toHaveProperty('MP_SEND_API_AUTH');
    });
});
