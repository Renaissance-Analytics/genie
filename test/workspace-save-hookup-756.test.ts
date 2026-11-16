import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import type { ElementSources } from '../src/core/workspace-elements.js';
import { workspaceSaveOps, type SaveFs, type SaveGit } from '../src/main/workspace-save-host.js';

/**
 * THE HOOK-UP (Tynn #756): Save to repo plans from project.json WITH the workspace's declarations in it. `workspaceSaveOps`
 * takes the sources of a workspace's services, settings and agents' IssueWatch and gives them to the planner, and both hosts
 * (the window's process and genie-host) hand it the registries those are read from. Fixtures are invented names.
 */

const V4 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.4.0/schemas/workspace/project.schema.json';
const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const pg = { id: 'svc_pg', engine: 'postgres', version: '17', variant: 'pgvector', scope: { kind: 'dedicated', workspaceId: 'acme' }, publishedPort: 55432, credentials: { password: 'hunter2' }, active: true } as unknown as ServiceInstance;
const sources = (): ElementSources => ({
    services: [pg],
    workspace: { overrides: { limit_terminals: '8' }, defaultAgent: 'lift', envFile: null, mcpOff: [] },
    agents: [{ name: 'lift', issueWatch: { delivery: 'push', kinds: ['issue.new'] } }],
});

function rig(options: { withElements?: boolean; elements?: (id: string) => ElementSources | Promise<ElementSources>; mayRead?: boolean } = {}) {
    const asked: string[] = [];
    const disk: Record<string, string> = { '/w/acme/project.json': `${JSON.stringify({ $schema: V4, name: 'Acme', agents: { lift: { purpose: 'Builds.' } } }, null, 2)}\n` };
    const writes: [string, string][] = [];
    const fs: SaveFs = { async readText(p) { return disk[p] ?? null; }, async writeTextAtomic(p, t) { writes.push([p, t]); disk[p] = t; } };
    const git: SaveGit = { async fetchUpstream() { return { ok: true }; }, async upstream() { return null; }, async mergeBase() { return null; }, async show() { return null; } };
    const elements = options.elements ?? ((id: string) => { asked.push(id); return sources(); });
    const ops = workspaceSaveOps({
        fs, git, pathOf: (id) => (id === 'acme' ? '/w/acme' : null),
        ...(options.mayRead === undefined ? {} : { mayReadFolder: () => options.mayRead! }),
        ...(options.withElements === false ? {} : { elements }),
    });
    return { ops, writes, asked };
}

describe('workspaceSaveOps with the workspace’s declarations', () => {
    it('the preview shows project.json as changed by them', async () => {
        const preview = await rig().ops.savePreview('acme');
        expect(preview.plan.ok).toBe(true);
        expect(preview.files).toEqual([{ path: 'project.json', status: 'changed' }]);
    });

    it('save writes services, the workspace settings and the agent’s issueWatch, stamped v0.5.0, with nothing machine-specific', async () => {
        const { ops, writes } = rig();
        expect(await ops.save('acme', {})).toEqual({ ok: true, written: ['project.json'] });
        const written = JSON.parse(writes[0]![1]);
        expect(written.$schema).toBe(V5);
        expect(written.services).toEqual([{ engine: 'postgres', variant: 'pgvector', version: '17', scope: 'dedicated', active: true }]);
        expect(written.workspace).toEqual({ limitTerminals: 8, defaultAgent: 'lift' });
        expect(written.agents.lift.issueWatch).toEqual({ delivery: 'push', kinds: ['issue.new'] });
        expect(JSON.stringify(written)).not.toMatch(/hunter2|55432/);
    });

    it('asks for the sources of the workspace it was asked about, and no other', async () => {
        const { ops, asked } = rig();
        await ops.savePreview('acme');
        await ops.savePreview('nowhere');
        expect(asked).toEqual(['acme']);
    });

    it('a provider that fails is a refusal in words, and nothing is written', async () => {
        const { ops, writes } = rig({ elements: () => { throw new Error('the engines are not loaded yet'); } });
        const preview = await ops.savePreview('acme');
        expect(preview.plan).toMatchObject({ ok: false, reason: 'the engines are not loaded yet' });
        expect((await ops.save('acme', {})).ok).toBe(false);
        expect(writes).toEqual([]);
    });

    it('CONTROL: without them project.json is saved as it is (an older host, a test)', async () => {
        const preview = await rig({ withElements: false }).ops.savePreview('acme');
        expect(preview.files).toEqual([{ path: 'project.json', status: 'unchanged' }]);
    });

    it('CONTROL: a hibernated workspace is a ghost: its sources are never read', async () => {
        const { ops, asked } = rig({ mayRead: false });
        expect((await ops.savePreview('acme')).plan.ok).toBe(false);
        expect(asked).toEqual([]);
    });
});

describe('both hosts', () => {
    it('the window’s process and genie-host give the save the registries the declarations are read from', () => {
        for (const file of ['src/main/main.ts', 'src/main/genie-host.ts']) {
            const text = src(file);
            expect(text, file).toContain('elementSourcesFor(');
            expect(text, file).toMatch(/workspaceSaveOps\(\{[^]*elements:/);
        }
    });
});
