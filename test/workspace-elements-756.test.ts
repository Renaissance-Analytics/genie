import { describe, expect, it } from 'vitest';
import { agentConfigOf, agentConfigsOf, agentConfigWrite } from '../src/core/agent-config.js';
import type { ServiceInstance } from '../src/core/services.js';
import { servicesDeclaration, servicesRestorePlan, withElements, workspaceSettingsDeclaration, workspaceSettingsRestore, type ElementSources } from '../src/core/workspace-elements.js';
import { SHARED_SCHEMAS_PIN } from '../src/core/shared-schemas-pin.js';
import { scanForMachineState } from '../src/core/workspace-save-guard.js';
import { planSave, type LiveModel } from '../src/core/workspace-save.js';
import { SCHEMA_REVISION } from '../src/core/workspace-model.js';
import { elementSourcesFor, liveModelWithElements } from '../src/main/workspace-save-sources.js';
import { WorkspaceSave, type SaveFs, type SaveGit } from '../src/main/workspace-save-host.js';

/**
 * THE WRITERS (Tynn #756, PR3): a workspace's services, workspace settings and agents' IssueWatch as what a repo keeps of
 * them, against the pinned shared-schemas v0.5.0, and what a fresh clone does with them. Only the declaration is saved:
 * never a credential, a published port, a container, a volume, a password, a capability grant or a safety setting.
 * Fixtures are invented names.
 */

const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';
const V4 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.4.0/schemas/workspace/project.schema.json';
const WS = 'acme';

const instance = (over: Record<string, unknown>): ServiceInstance => ({
    id: 'svc_1', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 55432,
    credentials: { user: 'u', password: 'hunter2', database: 'db' }, active: true, ...over,
}) as unknown as ServiceInstance;

const dedicatedPg = instance({ id: 'svc_pg', variant: 'pgvector', scope: { kind: 'dedicated', workspaceId: WS }, containerName: 'genie-pg-acme', volume: 'genie-pg-acme-data', admin: { user: 'root', password: 'rootpw' } });
const sharedRedis = instance({ id: 'svc_redis', engine: 'redis', version: '7', slices: { [WS]: { identifier: 'ws_acme', password: 'slicepw', prefix: 'ws_acme:', active: false } }, detached: [WS] });
const sharedOther = instance({ id: 'svc_other', engine: 'mysql', version: '8', slices: { someoneelse: { identifier: 'ws_x', password: 'p' } } });
const otherDedicated = instance({ id: 'svc_od', engine: 'mongo', version: '7', scope: { kind: 'dedicated', workspaceId: 'someoneelse' } });
const customSearch = instance({ id: 'svc_c', engine: 'custom', version: 'search', scope: { kind: 'dedicated', workspaceId: WS }, image: 'getmeili/meilisearch:v1', internalPort: 7700, kind: 'http', env: { MEILI_MASTER_KEY: 'topsecret', MEILI_ENV: 'development' } });

describe('services: only the declaration', () => {
    it('a dedicated engine: its engine, variant, major, scope and whether it is on', () => {
        expect(servicesDeclaration([dedicatedPg], WS).value).toEqual([{ engine: 'postgres', variant: 'pgvector', version: '17', scope: 'dedicated', active: true }]);
    });

    it('a shared engine this workspace uses: scope shared, its own slice decides active, and detached is said only when it is', () => {
        expect(servicesDeclaration([sharedRedis], WS).value).toEqual([{ engine: 'redis', version: '7', scope: 'shared', active: false, detached: true }]);
    });

    it('leaves out an engine the workspace does not use, and another workspace’s dedicated one', () => {
        const out = servicesDeclaration([sharedOther, otherDedicated, dedicatedPg], WS).value;
        expect(out).toEqual([{ engine: 'postgres', variant: 'pgvector', version: '17', scope: 'dedicated', active: true }]);
    });

    it('a custom engine: its name, image, the port INSIDE its container, its kind, and the NAMES of its env, never the values', () => {
        const out = servicesDeclaration([customSearch], WS).value;
        expect(out).toEqual([{ engine: 'custom', name: 'search', image: 'getmeili/meilisearch:v1', internalPort: 7700, kind: 'http', scope: 'dedicated', active: true, envKeys: ['MEILI_ENV', 'MEILI_MASTER_KEY'] }]);
    });

    it('carries no credential, published port, container, volume, password or admin: the guard finds nothing', () => {
        const out = servicesDeclaration([dedicatedPg, sharedRedis, customSearch], WS).value;
        expect(out).toHaveLength(3);
        expect(scanForMachineState({ services: out })).toEqual([]);
        expect(JSON.stringify(out)).not.toMatch(/hunter2|rootpw|slicepw|topsecret|55432|genie-pg-acme|ws_acme/);
    });

    it('CONTROL: the planted instances really do hold machine state, so "nothing found" above is not a blind scanner', () => {
        expect(scanForMachineState({ services: [dedicatedPg, sharedRedis, customSearch] }).length).toBeGreaterThan(0);
    });

    it('is in a stable order whatever order the engines were added in, so a save is not a reorder', () => {
        const a = servicesDeclaration([customSearch, sharedRedis, dedicatedPg], WS).value.map((s) => s.engine);
        const b = servicesDeclaration([dedicatedPg, customSearch, sharedRedis], WS).value.map((s) => s.engine);
        expect(a).toEqual(['custom', 'postgres', 'redis']);
        expect(b).toEqual(a);
    });

    it('a custom engine with no image is left out, and said; the rest still save', () => {
        const broken = instance({ id: 'svc_b', engine: 'custom', version: 'half', scope: { kind: 'dedicated', workspaceId: WS } });
        const out = servicesDeclaration([broken, dedicatedPg], WS);
        expect(out.value.map((s) => s.engine)).toEqual(['postgres']);
        expect(out.excluded).toEqual([{ field: 'services/custom:half', reason: expect.stringContaining('image') }]);
    });
});

describe('services: what a fresh clone does with them', () => {
    const decl = { engine: 'redis', version: '7', scope: 'shared', active: true };

    it('an engine this workspace already uses is left alone', () => {
        expect(servicesRestorePlan([decl], [sharedRedis], WS).actions).toEqual([{ declaration: decl, action: 'present', scope: 'shared', instanceId: 'svc_redis' }]);
    });

    it('a shared engine on this machine is ATTACHED, not made a second time', () => {
        const unused = instance({ id: 'svc_r2', engine: 'redis', version: '7', slices: {} });
        expect(servicesRestorePlan([decl], [unused], WS).actions).toEqual([{ declaration: decl, action: 'attach', scope: 'shared', instanceId: 'svc_r2' }]);
    });

    it('a different major is not a match; a dedicated declaration is made fresh even when a shared one exists; nothing carries a credential', () => {
        const other = instance({ id: 'svc_r8', engine: 'redis', version: '8', slices: {} });
        const plan = servicesRestorePlan([decl, { engine: 'redis', version: '7', scope: 'dedicated' }], [other, sharedOther], WS);
        expect(plan.actions.map((a) => [a.action, a.scope, a.instanceId])).toEqual([['create', 'shared', undefined], ['create', 'dedicated', undefined]]);
        expect(JSON.stringify(plan)).not.toMatch(/password|hunter2|slicepw|credentials/);
    });

    it('a declaration the schema would refuse is refused with its place, and the rest are planned', () => {
        const plan = servicesRestorePlan([{ engine: '' }, decl, { engine: 'custom', name: 'x' }, 'redis'], [], WS);
        expect(plan.refused.map((r) => r.index)).toEqual([0, 2, 3]);
        expect(plan.actions.map((a) => a.declaration.engine)).toEqual(['redis']);
    });

    it('something that is not a list is refused whole, in words', () => {
        const plan = servicesRestorePlan({ redis: {} }, [], WS);
        expect(plan.actions).toEqual([]);
        expect(plan.refused).toEqual([{ index: -1, reason: 'services is a list of engines' }]);
    });
});

describe('workspace settings: the allow-list', () => {
    const input = { overrides: { agent_cap: '4', limit_terminals: '8', limit_processes: '16' }, defaultAgent: 'lift', envFile: '.env.local', mcpOff: ['slack'] };

    it('saves what is portable: caps and limits as numbers, the default agent by NAME, the env file, MCP servers off', () => {
        expect(workspaceSettingsDeclaration(input).value).toEqual({ agentCap: 4, limitTerminals: 8, limitProcesses: 16, defaultAgent: 'lift', envFile: '.env.local', mcpOff: ['slack'] });
    });

    it('names the safety settings it will not save', () => {
        const out = workspaceSettingsDeclaration({ ...input, overrides: { ...input.overrides, approval_gates: 'none', app_inbox: false, playwright_server: false } });
        expect(out.excluded.map((e) => e.field).sort()).toEqual(['app_inbox', 'approval_gates', 'playwright_server']);
        expect(JSON.stringify(out.value)).not.toMatch(/approval|inbox|playwright/i);
    });

    it('a value Genie does not offer, a bad agent name and an absolute env file are left out, and said', () => {
        const out = workspaceSettingsDeclaration({ overrides: { agent_cap: '3', limit_terminals: '8' }, defaultAgent: 'Lift', envFile: 'C:/x/.env', mcpOff: [] });
        expect(out.value).toEqual({ limitTerminals: 8 });
        expect(out.excluded.map((e) => e.field).sort()).toEqual(['agent_cap', 'defaultAgent', 'envFile']);
    });

    it('CONTROL: nothing set means no key at all', () => {
        expect(workspaceSettingsDeclaration({ overrides: {}, defaultAgent: null, envFile: null, mcpOff: [] }).value).toBeNull();
    });

    it('a restore keeps the allow-list and IGNORES anything hand-added to loosen a safety setting or name a machine', () => {
        const out = workspaceSettingsRestore({ agentCap: 4, approval_gates: 'none', approvalGates: 'none', appInbox: true, app_inbox: true, playwright_server: true, path: '/x', id: '01ARZ', asleep: true, governs: ['a'], autoApprove: true });
        expect(out.settings).toEqual({ agent_cap: '4' });
        expect(out.ignored.sort()).toEqual(['appInbox', 'app_inbox', 'approvalGates', 'approval_gates', 'asleep', 'autoApprove', 'governs', 'id', 'path', 'playwright_server']);
    });

    it('a restore checks each value the way Genie offers it: a cap it does not offer, a bad name, an escaping env file, a non-list', () => {
        const out = workspaceSettingsRestore({ agentCap: 3, limitTerminals: 'many', defaultAgent: 'Lift', envFile: '../x', mcpOff: 'slack' });
        expect(out.settings).toEqual({});
        expect(out.defaultAgent).toBeNull();
        expect(out.envFile).toBeNull();
        expect(out.mcpOff).toBeNull();
        expect(out.ignored.sort()).toEqual(['agentCap', 'defaultAgent', 'envFile', 'limitTerminals', 'mcpOff']);
    });

    it('a save followed by a restore gives back the same settings', () => {
        const saved = workspaceSettingsDeclaration(input).value;
        expect(workspaceSettingsRestore(saved)).toEqual({ settings: { agent_cap: '4', limit_terminals: '8', limit_processes: '16' }, defaultAgent: 'lift', envFile: '.env.local', mcpOff: ['slack'], ignored: [] });
    });

    it('CONTROL: a clean declaration ignores nothing', () => {
        expect(workspaceSettingsRestore({ agentCap: 4, defaultAgent: 'lift' }).ignored).toEqual([]);
    });
});

describe('IssueWatch rides in an agent’s config', () => {
    const watch = { delivery: 'push', kinds: ['issue.new', 'ci.failed'] };

    it('an agent config may carry issueWatch { delivery, kinds }, and keeps it', () => {
        expect(agentConfigOf({ purpose: 'Builds.', issueWatch: watch })).toEqual({ purpose: 'Builds.', issueWatch: watch });
        expect(agentConfigsOf({ agents: { lift: { purpose: 'Builds.', issueWatch: watch } } })).toEqual({ lift: { purpose: 'Builds.', issueWatch: watch } });
    });

    it('a malformed issueWatch makes the config unreadable, never half-guessed', () => {
        for (const bad of [{ delivery: 'now', kinds: [] }, { delivery: 'push' }, { delivery: 'push', kinds: ['nope'] }, 'push']) {
            expect(agentConfigOf({ purpose: 'Builds.', issueWatch: bad }), JSON.stringify(bad)).toBeNull();
        }
    });

    it('writing a config with issueWatch persists it and stamps the pinned revision; another agent’s entry is untouched', () => {
        const text = `${JSON.stringify({ $schema: V4, name: 'A', agents: { scout: { purpose: 'Scouts.', issueWatch: { delivery: 'off', kinds: [] } } } }, null, 2)}\n`;
        const out = agentConfigWrite(text, { lift: { purpose: 'Builds.', issueWatch: watch } } as never);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const written = JSON.parse(out.text);
        expect(written.$schema).toBe(V5);
        expect(written.agents.lift.issueWatch).toEqual(watch);
        expect(written.agents.scout).toEqual({ purpose: 'Scouts.', issueWatch: { delivery: 'off', kinds: [] } });
    });
});

describe('the elements in project.json', () => {
    const base = (): LiveModel => {
        const manifest = { $schema: V4, name: 'Acme', repos: [{ name: 'app', path: 'repos/app' }], agents: { lift: { purpose: 'Builds.' }, scout: { purpose: 'Scouts.', issueWatch: { delivery: 'off', kinds: [] } } } };
        return { manifest, manifestText: `${JSON.stringify(manifest, null, 2)}\n`, files: [] };
    };
    const sources = (over: Partial<ElementSources> = {}): ElementSources => ({
        services: [dedicatedPg],
        workspace: { overrides: { agent_cap: '4' }, defaultAgent: 'lift', envFile: null, mcpOff: [] },
        agents: [{ name: 'lift', issueWatch: { delivery: 'push', kinds: ['issue.new'] } }, { name: 'scout', issueWatch: null }],
        ...over,
    });

    it('puts services and the workspace settings into the manifest and keeps every other key', () => {
        const { manifest } = withElements(base(), sources(), WS).model;
        expect(manifest.services).toEqual([{ engine: 'postgres', variant: 'pgvector', version: '17', scope: 'dedicated', active: true }]);
        expect(manifest.workspace).toEqual({ agentCap: 4, defaultAgent: 'lift' });
        expect(manifest.repos).toEqual([{ name: 'app', path: 'repos/app' }]);
        expect(manifest.name).toBe('Acme');
    });

    it('takes a key out when nothing is left to declare, so a cleared setting is a saved change', () => {
        const model = withElements(base(), sources(), WS).model;
        expect(model.manifest.services).toBeDefined();
        expect(model.manifest.workspace).toBeDefined();
        const cleared = withElements(model, sources({ services: [], workspace: { overrides: {}, defaultAgent: null, envFile: null, mcpOff: [] } }), WS).model;
        expect('services' in cleared.manifest).toBe(false);
        expect('workspace' in cleared.manifest).toBe(false);
    });

    it('sets an agent’s issueWatch on its own entry, removes it when the agent has none, and skips an agent with no config entry', () => {
        const { manifest } = withElements(base(), sources({ agents: [{ name: 'lift', issueWatch: { delivery: 'push', kinds: ['issue.new'] } }, { name: 'scout', issueWatch: null }, { name: 'ghost', issueWatch: { delivery: 'count', kinds: [] } }] }), WS).model;
        const agents = manifest.agents as Record<string, Record<string, unknown>>;
        expect(agents.lift).toEqual({ purpose: 'Builds.', issueWatch: { delivery: 'push', kinds: ['issue.new'] } });
        expect(agents.scout).toEqual({ purpose: 'Scouts.' });
        expect('ghost' in agents).toBe(false);
    });

    it('a manifest with these is planned at the pinned revision, and its $schema names the v0.5.0 tag', () => {
        const plan = planSave(withElements(base(), sources(), WS).model);
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.stampedTo).toBe(SHARED_SCHEMAS_PIN.revision);
        expect(JSON.parse(plan.files[0]!.text).$schema).toBe(V5);
    });

    it('keeps the tynn-c5 guard: this envelope’s own site still refuses the save, and without it the same save is planned', () => {
        const c5 = { repo: 'tynn-c5-proof', runMode: 'host', kind: 'http', enabled: true, name: 'tynn-c5', command: ['powershell', '-File', 'C:/_Projects/tynn.ai/.ai/sandbox/genie-marketplace-c5/serve-proof.ps1', '-Port', '{port}'] };
        const dirty = base();
        const withSite = withElements({ ...dirty, manifest: { ...dirty.manifest, sites: { '998de12a1f1278a9': c5 } } }, sources(), WS).model;
        const refused = planSave(withSite);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.violations.map((v) => v.path)).toContain('project.json.sites.998de12a1f1278a9.command[2]');
        const clean = planSave(withElements(dirty, sources(), WS).model);
        expect(clean.ok).toBe(true);
    });

    it('this Genie writes the revision the pin names', () => {
        expect(SCHEMA_REVISION).toBe('0.5.0');
        expect(SHARED_SCHEMAS_PIN.revision).toBe(SCHEMA_REVISION);
        expect(SHARED_SCHEMAS_PIN.tag).toBe(`v${SCHEMA_REVISION}`);
    });
});

describe('what the workspace holds', () => {
    const ports = () => ({
        services: { list: () => [dedicatedPg, sharedRedis] },
        settings: { workspaceValues: (id: string) => (id === WS ? { agent_cap: '4', approval_gates: 'none' } : { agent_cap: '16' }) },
        registry: {
            chosenDefaultAgentOf: (id: string) => (id === WS ? 'agent_1' : null),
            workspaceMcpOff: (id: string) => (id === WS ? ['slack'] : []),
            listAgents: () => [
                { id: 'agent_1', name: 'lift', workspaceId: WS, issueWatch: { delivery: 'push' as const, kinds: ['issue.new' as const] } },
                { id: 'agent_2', name: 'scout', workspaceId: WS },
                { id: 'agent_3', name: 'stranger', workspaceId: 'someoneelse', issueWatch: { delivery: 'off' as const, kinds: [] } },
            ],
            listWorkspaces: () => [{ id: WS, envFile: '.env.local' }, { id: 'someoneelse', envFile: '.env' }],
        },
    });

    it('is this workspace’s services, overrides, default agent by name, MCP servers off, env file and only its own agents', () => {
        const s = elementSourcesFor(ports(), WS);
        expect(s.services.map((i) => i.id)).toEqual(['svc_pg', 'svc_redis']);
        expect(s.workspace).toEqual({ overrides: { agent_cap: '4', approval_gates: 'none' }, defaultAgent: 'lift', envFile: '.env.local', mcpOff: ['slack'] });
        expect(s.agents).toEqual([{ name: 'lift', issueWatch: { delivery: 'push', kinds: ['issue.new'] } }, { name: 'scout', issueWatch: null }]);
    });

    it('CONTROL: a workspace with no default agent has none', () => {
        expect(elementSourcesFor(ports(), 'someoneelse').workspace.defaultAgent).toBeNull();
    });
});

describe('through Save to repo', () => {
    const disk = () => ({ '/w/acme/project.json': `${JSON.stringify({ $schema: V4, name: 'Acme', agents: { lift: { purpose: 'Builds.' } } }, null, 2)}\n` } as Record<string, string>);
    const read = (files: Record<string, string>) => async (path: string): Promise<LiveModel | null> => {
        const manifestText = files[`${path}/project.json`];
        return manifestText === undefined ? null : { manifest: JSON.parse(manifestText), manifestText, files: [] };
    };
    const sources = (): ElementSources => ({
        services: [dedicatedPg],
        workspace: { overrides: { limit_terminals: '8' }, defaultAgent: 'lift', envFile: null, mcpOff: [] },
        agents: [{ name: 'lift', issueWatch: { delivery: 'push', kinds: ['issue.new'] } }],
    });
    const saver = (files: Record<string, string>, writes: [string, string][]) => {
        const fs: SaveFs = { async readText(p) { return files[p] ?? null; }, async writeTextAtomic(p, t) { writes.push([p, t]); files[p] = t; } };
        const git: SaveGit = { async fetchUpstream() { return { ok: true }; }, async upstream() { return null; }, async mergeBase() { return null; }, async show() { return null; } };
        return new WorkspaceSave({ fs, git, liveModel: liveModelWithElements(read(files), sources, WS) });
    };

    it('CONTROL: a workspace with no project.json has no live model, declarations or not', async () => {
        expect(await liveModelWithElements(read({}), sources, WS)('/w/acme')).toBeNull();
    });

    it('the preview shows project.json as changed by the declarations', async () => {
        const preview = await saver(disk(), []).preview('/w/acme');
        expect(preview.plan.ok).toBe(true);
        expect(preview.files).toEqual([{ path: 'project.json', status: 'changed' }]);
    });

    it('save writes the three declarations into project.json, stamped v0.5.0, in the file style; nothing machine-specific', async () => {
        const writes: [string, string][] = [];
        expect(await saver(disk(), writes).save('/w/acme', {})).toEqual({ ok: true, written: ['project.json'] });
        const written = JSON.parse(writes[0]![1]);
        expect(written.$schema).toBe(V5);
        expect(written.services).toEqual([{ engine: 'postgres', variant: 'pgvector', version: '17', scope: 'dedicated', active: true }]);
        expect(written.workspace).toEqual({ limitTerminals: 8, defaultAgent: 'lift' });
        expect(written.agents.lift).toEqual({ purpose: 'Builds.', issueWatch: { delivery: 'push', kinds: ['issue.new'] } });
        expect(scanForMachineState(written)).toEqual([]);
    });
});
