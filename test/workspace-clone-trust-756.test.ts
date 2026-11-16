import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowDocument } from '../src/core/flow-form.js';
import { flowsDeclaration } from '../src/core/workspace-flows.js';
import { processesDeclaration } from '../src/core/workspace-processes.js';
import { FlowStore } from '../src/main/flow-store.js';
import { restoreClone, type CloneRestorePorts } from '../src/main/workspace-clone-restore-host.js';
import { restoreFlows } from '../src/main/workspace-flows-host.js';

/**
 * AFTER THE YES, AND NOTHING ARMED (Tynn #756, PR9b; the coordinator, 2026-11-16: "nothing a clone brings in should be armed or running
 * without a person's action, whatever it contains"). The restore is idempotent, so running it again after the person trusts creates
 * what waited and leaves what came in the first time alone; and what is created is DISARMED, proven against the real flow store.
 * Fixtures are invented names.
 */

const WS = { id: 'ws_clone', path: '/c/acme' };
const flowFile = (name: string, step: Parameters<typeof flowDocument>[0]['step']) => JSON.stringify(flowsDeclaration([{ name, workspaceId: 'w', document: flowDocument({ workspaceId: 'w', cron: '0 3 * * *', step }) as unknown as Record<string, unknown> }], 'w').files[0]!.value);
const worker = JSON.stringify(processesDeclaration([{ name: 'Queue worker', workspaceId: 'w', command: 'php artisan queue:work', cwd: '/c/acme/repos/app', restart: 'always' }], 'w', '/c/acme').files[0]!.value);

describe('running the restore again after the person trusts', () => {
    it('CONTROL: what waited is created on the second run, what came in the first time is present, and nothing is made twice', async () => {
        const files: Record<string, string> = {
            '/c/acme/project.json': '{"name":"Acme"}',
            '/c/acme/.flows/quiet.json': flowFile('Quiet', { kind: 'log' }),
            '/c/acme/.flows/nightly-backup.json': flowFile('Nightly backup', { kind: 'command', command: 'npm run backup', folder: '' }),
            '/c/acme/.processes/queue-worker.json': worker,
        };
        const flows: { name: string; document: unknown }[] = [];
        const kept: { name: string }[] = [];
        let trusted = false;
        const ports: CloneRestorePorts = {
            files: { read: async (p) => files[p] ?? null, list: async (dir) => { const n = Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)); if (n.length === 0) throw new Error('ENOENT'); return n; } },
            settings: { agentsOf: () => [], overridden: () => ({}), setSetting: async () => {}, defaultAgentOf: () => null, setDefaultAgent: async () => {}, envFileOf: () => null, defaultEnvFile: () => '.env', setEnvFile: async () => {}, mcpOff: () => [], setMcpServer: async () => {} },
            tabs: { values: () => ({ tabs: '', panelSplits: '', panelLayout: '' }), overridden: () => ({}), write: async () => {}, siteHosts: () => [] },
            flows: async () => ({ list: () => flows, create: async (input) => { flows.push({ name: input.name, document: input.document }); return input; } }),
            processes: async () => ({ list: () => [], keep: async (input) => { kept.push({ name: input.name }); return input; }, agentAddressOf: () => null }),
            trusted: () => trusted,
        };
        const before = await restoreClone(WS, ports);
        expect(before.flows?.created).toEqual(['.flows/quiet.json']);
        expect(before.flows?.waiting.map((w) => w.file)).toEqual(['.flows/nightly-backup.json']);
        expect(before.processes?.waiting.map((w) => w.file)).toEqual(['.processes/queue-worker.json']);
        expect(kept).toEqual([]);
        trusted = true;
        const after = await restoreClone(WS, ports);
        expect(after.flows?.created).toEqual(['.flows/nightly-backup.json']);
        expect(after.flows?.present).toEqual(['.flows/quiet.json']);
        expect(after.processes?.created).toEqual(['.processes/queue-worker.json']);
        expect(flows.map((f) => f.name).sort()).toEqual(['nightly-backup', 'quiet']);
        expect(kept.map((k) => k.name)).toEqual(['queue-worker']);
    });
});

describe('what is created is disarmed, against the real flow store', () => {
    let dir = '';
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-clone-flows-756-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('CONTROL: a log-only flow and a flow that runs a command both come in armed: false, and arming stays a separate act the store can tell apart', async () => {
        const store = await FlowStore.open(dir);
        const files = [
            { path: '.flows/quiet.json', text: flowFile('Quiet', { kind: 'log' }) },
            { path: '.flows/nightly-backup.json', text: flowFile('Nightly backup', { kind: 'command', command: 'npm run backup', folder: '' }) },
        ];
        const out = await restoreFlows(files, 'ws_clone', { list: (id) => store.list(id), create: (input) => store.create(input) }, { trusted: true });
        expect(out.created).toHaveLength(2);
        const made = store.list('ws_clone');
        expect(made.map((f) => [f.name, f.armed]).sort()).toEqual([['nightly-backup', false], ['quiet', false]]);
        // The positive control: the same store arms a flow when a person asks it to at create, so the line above can fail.
        const person = await store.create({ workspaceId: 'ws_clone', name: 'armed-by-a-person', document: JSON.parse(files[0]!.text.replace(/\$\{workspace\}/g, 'ws_clone')), by: { kind: 'user' }, armed: true });
        expect(person.armed).toBe(true);
        // And an agent cannot arm one by asking.
        const agent = await store.create({ workspaceId: 'ws_clone', name: 'armed-by-an-agent', document: JSON.parse(files[0]!.text.replace(/\$\{workspace\}/g, 'ws_clone')), by: { kind: 'agent', id: 'a', name: 'lift' }, armed: true });
        expect(agent.armed).toBe(false);
    });
});

describe('in genie-host', () => {
    it('what waited for the trust is restored when the person trusts, through the same restore that ran when the workspace appeared', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        expect(host).toMatch(/\.onTrusted\??\.?\(/);
        expect(host.match(/restoreClone\(/g)?.length).toBe(1);
    });
});
