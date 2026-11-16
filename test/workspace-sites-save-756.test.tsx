import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { saveDialogView } from '../src/core/save-dialog-view.js';
import { scanForMachineState } from '../src/core/workspace-save-guard.js';
import { planSave, type LiveModel, type SavePreview } from '../src/core/workspace-save.js';
import { SaveToRepoView } from '../src/renderer/components/SaveToRepoDialog.js';
import { workspaceSaveOps, type SaveFs, type SaveGit } from '../src/main/workspace-save-host.js';

/**
 * SITES, THROUGH SAVE TO REPO (Tynn #756, PR4): the rewrite happens on the way to the file, is told to the person (what became
 * what), and a path that cannot be made relative is refused with how to fix it. Fixtures: this envelope's own tynn-c5 entry
 * and invented names.
 */

const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';
const C5_KEY = '998de12a1f1278a9';
const C5_SCRIPT = 'C:/_Projects/tynn.ai/.ai/sandbox/genie-marketplace-c5/serve-proof.ps1';
const C5 = { repo: 'tynn-c5-proof', runMode: 'host', kind: 'http', enabled: true, name: 'tynn-c5', genName: 'tynn-c5.gen', command: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', C5_SCRIPT, '-Port', '{port}'] };
const WORKSPACE = 'C:/_Projects/tynn.ai';

function rig(project: Record<string, unknown>) {
    const disk: Record<string, string> = { [`${WORKSPACE}/project.json`]: `${JSON.stringify(project, null, 2)}\n` };
    const writes: [string, string][] = [];
    const fs: SaveFs = { async readText(p) { return disk[p] ?? null; }, async writeTextAtomic(p, t) { writes.push([p, t]); disk[p] = t; } };
    const git: SaveGit = { async fetchUpstream() { return { ok: true }; }, async upstream() { return null; }, async mergeBase() { return null; }, async show() { return null; } };
    return { ops: workspaceSaveOps({ fs, git, pathOf: (id) => (id === 'tynn' ? WORKSPACE : null) }), writes };
}
const envelope = (sites: Record<string, unknown>) => ({ $schema: V5, name: 'Tynn', repos: [{ name: 'tynn', path: 'repos/tynn' }], sites });

describe('the guard says how to fix an absolute path', () => {
    it('names the fix: put what it runs inside the workspace and use a relative path', () => {
        const [v] = scanForMachineState({ command: ['node', 'D:/elsewhere/server.js'] });
        expect(v?.rule).toBe('absolute-path');
        expect(v?.reason).toContain('relative path inside the workspace');
    });
});

describe('through the dialog’s own path', () => {
    it('this envelope’s tynn-c5 entry now SAVES: the plan is ok and says what became what, and that its repo is not in repos[]', async () => {
        const preview = await rig(envelope({ [C5_KEY]: C5 })).ops.savePreview('tynn');
        expect(preview.plan.ok).toBe(true);
        if (!preview.plan.ok) return;
        expect(preview.plan.notes).toContain(`sites.${C5_KEY}.command[5]: ${C5_SCRIPT} saved as ../../.ai/sandbox/genie-marketplace-c5/serve-proof.ps1`);
        expect(preview.plan.notes).toContain('Site tynn-c5: its repo "tynn-c5-proof" is not in repos[], so a clone has no folder for it.');
        expect(preview.files).toEqual([{ path: 'project.json', status: 'changed' }]);
    });

    it('save writes the relative command, keeps the key, and the written file is clean', async () => {
        const { ops, writes } = rig(envelope({ [C5_KEY]: C5 }));
        expect(await ops.save('tynn', {})).toEqual({ ok: true, written: ['project.json'] });
        const written = JSON.parse(writes[0]![1]);
        expect(written.sites[C5_KEY].command[5]).toBe('../../.ai/sandbox/genie-marketplace-c5/serve-proof.ps1');
        expect(written.sites[C5_KEY].name).toBe('tynn-c5');
        expect(scanForMachineState(written)).toEqual([]);
    });

    it('a path outside the workspace is refused, naming the field and how to fix it, and nothing is written', async () => {
        const { ops, writes } = rig(envelope({ k1: { repo: 'tynn', name: 'app', command: ['node', 'D:/elsewhere/server.js', '--port={port}'] } }));
        const preview = await ops.savePreview('tynn');
        expect(preview.plan.ok).toBe(false);
        if (!preview.plan.ok) {
            expect(preview.plan.violations.map((v) => v.path)).toEqual(['project.json.sites.k1.command[1]']);
            expect(preview.plan.reason).toContain('relative path inside the workspace');
        }
        expect((await ops.save('tynn', {})).ok).toBe(false);
        expect(writes).toEqual([]);
    });

    it('CONTROL: an envelope with a site that is already portable plans with no note and no rewrite', async () => {
        const { ops } = rig(envelope({ k1: { repo: 'tynn', name: 'app', hostServe: { mode: 'php', root: 'public' } } }));
        const preview = await ops.savePreview('tynn');
        expect(preview.plan.ok).toBe(true);
        if (preview.plan.ok) expect(preview.plan.notes ?? []).toEqual([]);
        expect(preview.files).toEqual([{ path: 'project.json', status: 'unchanged' }]);
    });
});

describe('the plan and the dialog carry the notes', () => {
    const model = (notes: string[]): LiveModel => ({ manifest: { $schema: V5, name: 'T' }, manifestText: `${JSON.stringify({ $schema: V5, name: 'T' }, null, 2)}\n`, files: [], notes });

    it('a plan carries what the loader told it', () => {
        const plan = planSave(model(['one thing', 'another']));
        expect(plan.ok && plan.notes).toEqual(['one thing', 'another']);
    });

    const preview = (notes: string[]): SavePreview => ({ plan: { ok: true, files: [], backups: [], stampedTo: null, notes }, files: [{ path: 'project.json', status: 'changed' }], upstream: { fetched: true, ref: null }, decisions: [], conflicts: [] });
    const view = (notes: string[]) => saveDialogView({ preview: preview(notes), choices: {}, busy: false, error: null, saved: null });

    it('the dialog’s view lists them, and has none when there are none', () => {
        expect(view(['sites.k1.command[5]: C:/x/y saved as ./y']).notes).toEqual(['sites.k1.command[5]: C:/x/y saved as ./y']);
        expect(view([]).notes).toEqual([]);
    });

    it('the dialog shows what was rewritten for the repo', () => {
        const html = renderToStaticMarkup(<SaveToRepoView workspaceName="Acme" view={view(['sites.k1.command[5]: C:/x/y saved as ./y'])} onChoose={() => {}} onSave={() => {}} onClose={() => {}} />);
        expect(html).toContain('data-save-notes=""');
        expect(html).toContain('saved as ./y');
    });
});
