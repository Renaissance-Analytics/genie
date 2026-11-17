import { describe, expect, it } from 'vitest';
import { flowDocument, type FlowStep } from '../src/core/flow-form.js';
import { cwdProblem, scanForMachineState } from '../src/core/workspace-save-guard.js';
import { planSave } from '../src/core/workspace-save.js';
import { restoreFlows, type FlowPorts } from '../src/main/workspace-flows-host.js';

/**
 * A `cwd` IS A FOLDER INSIDE THE WORKSPACE (Tynn #756, PR5 hardening). The generic absolute-path scan needs two segments or a
 * well-known root, so it misses `/data`, and it cannot see a RELATIVE path that climbs out (`../../elsewhere`). A `cwd` is
 * checked by its own rule: relative (no leading slash or backslash, no drive, no UNC, no `~`), and once normalised it stays
 * inside the workspace. The same check refuses a flow step's cwd on restore, where a clone's file is not to be trusted.
 */

const OUTSIDE = ['/data', '/app', 'C:\\x', 'C:/x', 'C:x', '~/x', '~', '../../x', '..', '..\\x', 'repos/../../x', 'repos\\..\\..\\x', '\\\\server\\share\\x', ''];
const INSIDE = ['.', 'repos/x', './scripts', 'a/b/../c', 'repos\\x', 'scripts/'];

describe('the cwd rule', () => {
    it('CONTROL: a folder inside the workspace is fine, written any of the usual ways', () => {
        for (const cwd of INSIDE) expect(scanForMachineState({ cwd }), cwd).toEqual([]);
    });

    it('anything that is not a relative folder inside the workspace is one violation under the rule’s own name', () => {
        for (const cwd of OUTSIDE) {
            const found = scanForMachineState({ cwd });
            expect(found.map((v) => [v.path, v.rule]), JSON.stringify(cwd)).toEqual([['cwd', 'unsafe-cwd']]);
        }
    });

    it('names the field where it is, however deep, and says how to fix it', () => {
        const found = scanForMachineState({ sites: { k1: { cwd: '/data' } }, graph: { nodes: [{ config: { cwd: '../../x' } }] } }, 'doc');
        expect(found.map((v) => v.path)).toEqual(['doc.sites.k1.cwd', 'doc.graph.nodes[0].config.cwd']);
        expect(found[0]!.reason).toContain('a folder inside the workspace');
    });

    it('is read the same by cwdProblem, for a caller that has only the value', () => {
        for (const cwd of INSIDE) expect(cwdProblem(cwd), cwd).toBeNull();
        for (const cwd of OUTSIDE) expect(cwdProblem(cwd), JSON.stringify(cwd)).not.toBeNull();
    });

    it('CONTROL: another key holding /data is not this rule’s business, and a cwd that is not text is not read', () => {
        expect(scanForMachineState({ label: '/data', cwdNote: '/data', mount: '/app' })).toEqual([]);
        expect(scanForMachineState({ cwd: null })).toEqual([]);
        expect(scanForMachineState({ cwd: 7 })).toEqual([]);
    });

    it('a flow step that runs in /data refuses the whole save, naming the step’s field', () => {
        const step: FlowStep = { kind: 'command', command: 'ls', folder: '/data' };
        const doc = flowDocument({ workspaceId: '${workspace}', cron: '0 3 * * *', step });
        const plan = planSave({ manifest: { name: 'A' }, manifestText: '{"name":"A"}\n', files: [{ path: '.flows/ls.json', value: doc }] });
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.violations.map((v) => [v.path, v.rule])).toEqual([['.flows/ls.json.graph.nodes[1].config.cwd', 'unsafe-cwd']]);
    });
});

describe('restoring a flow whose step names a folder', () => {
    const stepFile = (folder: string, name = 'step') => ({
        path: `.flows/${name}.json`,
        text: JSON.stringify(flowDocument({ workspaceId: '${workspace}', cron: '0 3 * * *', step: { kind: 'command', command: 'ls', folder } })),
    });
    const rig = () => {
        const created: { name: string }[] = [];
        const ports: FlowPorts = { list: () => [], create: async (input) => { created.push(input); return input; } };
        return { ports, created };
    };

    it('refuses one that leaves the workspace, says why, and still restores the good one beside it', async () => {
        const { ports, created } = rig();
        const files = [stepFile('../../x', 'climbs'), stepFile('/data', 'rooted'), stepFile('C:\\x', 'drive'), stepFile('~/x', 'home'), stepFile('repos/x', 'fine')];
        const out = await restoreFlows(files, 'ws_clone', ports, { trusted: true });
        expect(out.refused.map((r) => r.file)).toEqual(['.flows/climbs.json', '.flows/rooted.json', '.flows/drive.json', '.flows/home.json']);
        for (const r of out.refused) expect(r.reason, r.file).toContain('cwd');
        expect(out.created).toEqual(['.flows/fine.json']);
        expect(created.map((c) => c.name)).toEqual(['fine']);
    });

    it('CONTROL: a step in the workspace folder itself, a repo folder or ./scripts comes in', async () => {
        const { ports } = rig();
        const out = await restoreFlows([stepFile('.', 'root'), stepFile('repos/x', 'repo'), stepFile('./scripts', 'scripts')], 'ws_clone', ports, { trusted: true });
        expect(out.created).toEqual(['.flows/root.json', '.flows/repo.json', '.flows/scripts.json']);
        expect(out.refused).toEqual([]);
    });
});
