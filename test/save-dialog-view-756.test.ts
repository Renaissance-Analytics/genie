import { describe, expect, it } from 'vitest';
import { elementLabel, fileLabel, saveDialogView, type SaveDialogInput } from '../src/core/save-dialog-view.js';
import type { MergeDecision, SavePlan, SavePreview } from '../src/core/workspace-save.js';

/**
 * THE SAVE TO REPO DIALOG'S VIEW MODEL (Tynn #756 UI; the owner, 2026-11-16: a "Save to repo" button with a diff that is
 * upstream-aware). Pure: a preview from the host and the person's choices in, what the dialog says and whether Save is
 * enabled out. Save stays disabled until every conflict is settled; a guard refusal names each field; a failed fetch is a
 * warning that does not block. Fixtures are invented names.
 */

const okPlan: SavePlan = { ok: true, files: [{ path: 'project.json', text: '{}' }], backups: [], stampedTo: null };
const preview = (over: Partial<SavePreview> = {}): SavePreview => ({
    plan: okPlan,
    files: [{ path: 'project.json', status: 'changed' }],
    upstream: { fetched: true, ref: 'origin/main' },
    decisions: [],
    conflicts: [],
    ...over,
});
const d = (id: string, kind: MergeDecision['kind'], local: unknown, incoming: unknown): MergeDecision => ({ id, kind, base: undefined, local, incoming });
const view = (p: SavePreview | null, over: Partial<SaveDialogInput> = {}) => saveDialogView({ preview: p, choices: {}, busy: false, error: null, saved: null, ...over });

const conflictPreview = () => preview({
    decisions: [d('project.json#sites/a1', 'conflict', { name: 'mine' }, { name: 'theirs' }), d('project.json#sites/b2', 'conflict', { name: 'x' }, undefined)],
    conflicts: ['project.json#sites/a1', 'project.json#sites/b2'],
});

describe('what the dialog shows', () => {
    it('is loading until the preview arrives, and cannot save', () => {
        const v = view(null);
        expect(v.loading).toBe(true);
        expect(v.canSave).toBe(false);
        expect(v.files).toEqual([]);
    });

    it('a changed file can be saved, in words', () => {
        const v = view(preview());
        expect(v.loading).toBe(false);
        expect(v.canSave).toBe(true);
        expect(v.saveLabel).toBe('Save');
        expect(v.files).toEqual([{ path: 'project.json', label: 'Workspace settings (project.json)', status: 'changed', words: 'Changed' }]);
    });

    it('says New, Changed or No change for each file, with a name a person recognises', () => {
        const v = view(preview({ files: [{ path: '.flows/nightly.json', status: 'added' }, { path: '.processes/queue.json', status: 'changed' }, { path: '.genie/tabs.json', status: 'unchanged' }] }));
        expect(v.files.map((f) => [f.label, f.words])).toEqual([['Flow: nightly', 'New'], ['Process: queue', 'Changed'], ['Workspace tabs', 'No change']]);
    });

    it('names elements: a site, an agent, a service, a setting, a flow', () => {
        expect(elementLabel('project.json#sites/a1')).toBe('Site a1');
        expect(elementLabel('project.json#agents/lift')).toBe('Agent lift');
        expect(elementLabel('project.json#services/postgres:pgvector')).toBe('Service postgres:pgvector');
        expect(elementLabel('project.json#workspace')).toBe('Workspace settings');
        expect(elementLabel('project.json#name')).toBe('Name');
        expect(elementLabel('.flows/nightly.json')).toBe('Flow: nightly');
        expect(fileLabel('.genie/tabs.json')).toBe('Workspace tabs');
    });

    it('lists what teammates changed (incoming) and nothing that is only ours or the same', () => {
        const v = view(preview({ decisions: [d('project.json#sites/a1', 'incoming', undefined, { n: 1 }), d('project.json#sites/b2', 'local', { n: 1 }, undefined), d('project.json#name', 'same', 'T', 'T')] }));
        expect(v.incoming).toEqual([{ id: 'project.json#sites/a1', label: 'Site a1' }]);
    });
});

describe('conflicts: yours or theirs, and Save waits', () => {
    it('lists each conflict with both values and no choice yet; Save is disabled and says why', () => {
        const v = view(conflictPreview());
        expect(v.conflicts).toEqual([
            { id: 'project.json#sites/a1', label: 'Site a1', local: '{"name":"mine"}', incoming: '{"name":"theirs"}', choice: null },
            { id: 'project.json#sites/b2', label: 'Site b2', local: '{"name":"x"}', incoming: '(removed)', choice: null },
        ]);
        expect(v.canSave).toBe(false);
        expect(v.note).toBe('Choose yours or theirs for 2 conflicts before saving.');
    });

    it('one conflict says so in the singular', () => {
        const p = preview({ decisions: [d('project.json#sites/a1', 'conflict', 1, 2)], conflicts: ['project.json#sites/a1'] });
        expect(view(p).note).toBe('Choose yours or theirs for 1 conflict before saving.');
    });

    it('stays disabled until EVERY conflict has a choice, then enables with no note', () => {
        const p = conflictPreview();
        const half = view(p, { choices: { 'project.json#sites/a1': 'incoming' } });
        expect(half.conflicts.map((c) => c.choice)).toEqual(['incoming', null]);
        expect(half.canSave).toBe(false);
        const all = view(p, { choices: { 'project.json#sites/a1': 'incoming', 'project.json#sites/b2': 'local' } });
        expect(all.conflicts.map((c) => c.choice)).toEqual(['incoming', 'local']);
        expect(all.canSave).toBe(true);
        expect(all.note).toBeNull();
    });

    it('a long value is cut with an ellipsis, so a row stays a row', () => {
        const p = preview({ decisions: [d('project.json#sites/a1', 'conflict', { text: 'x'.repeat(200) }, 1)], conflicts: ['project.json#sites/a1'] });
        const local = view(p).conflicts[0]!.local;
        expect(local.length).toBeLessThanOrEqual(81);
        expect(local.endsWith('…')).toBe(true);
    });
});

describe('a refusal names each field', () => {
    const refused = (): SavePreview => preview({
        plan: {
            ok: false,
            reason: 'Nothing was saved. two things',
            violations: [
                { path: 'project.json.sites.k1.command[5]', rule: 'absolute-path', reason: 'project.json.sites.k1.command[5] holds an absolute path' },
                { path: 'project.json.sites.k1.password', rule: 'secret-key', reason: 'project.json.sites.k1.password is named like a secret' },
            ],
        },
        files: [],
    });

    it('lists every violating field with its reason, offers no save, and files nothing', () => {
        const v = view(refused());
        expect(v.refusal?.fields).toEqual([
            { path: 'project.json.sites.k1.command[5]', reason: 'project.json.sites.k1.command[5] holds an absolute path' },
            { path: 'project.json.sites.k1.password', reason: 'project.json.sites.k1.password is named like a secret' },
        ]);
        expect(v.canSave).toBe(false);
        expect(v.files).toEqual([]);
        expect(v.note).toBe('Nothing can be saved until this is fixed.');
    });

    it('a refusal with no field (a newer schema) says its reason alone', () => {
        const v = view(preview({ plan: { ok: false, reason: 'project.json declares schema 9.0.0, newer than this Genie writes', violations: [] }, files: [] }));
        expect(v.refusal).toEqual({ reason: 'project.json declares schema 9.0.0, newer than this Genie writes', fields: [] });
        expect(v.canSave).toBe(false);
    });

    it('CONTROL: a clean plan has no refusal', () => {
        expect(view(preview()).refusal).toBeNull();
    });
});

describe('upstream', () => {
    it('a failed fetch is a warning that says why, and does NOT stop Save', () => {
        const v = view(preview({ upstream: { fetched: false, ref: 'origin/main', reason: 'could not resolve host' } }));
        expect(v.warning).toContain('could not resolve host');
        expect(v.canSave).toBe(true);
    });

    it('CONTROL: a good fetch has no warning', () => {
        expect(view(preview()).warning).toBeNull();
    });

    it('no upstream branch is said as information, not as a warning', () => {
        const v = view(preview({ upstream: { fetched: true, ref: null } }));
        expect(v.warning).toBeNull();
        expect(v.info).toBe("This branch has no upstream, so teammates' changes are not shown.");
    });
});

describe('when there is nothing to save, and while saving', () => {
    it('everything unchanged and nothing incoming: nothing to save', () => {
        const v = view(preview({ files: [{ path: 'project.json', status: 'unchanged' }] }));
        expect(v.canSave).toBe(false);
        expect(v.note).toBe('Nothing to save: the repo already matches.');
    });

    it('CONTROL: unchanged files with an incoming change still save (the change comes in)', () => {
        const v = view(preview({ files: [{ path: 'project.json', status: 'unchanged' }], decisions: [d('project.json#sites/a1', 'incoming', undefined, { n: 1 })] }));
        expect(v.canSave).toBe(true);
    });

    it('while saving, the button says so and cannot be pressed again', () => {
        const v = view(preview(), { busy: true });
        expect(v.saveLabel).toBe('Saving…');
        expect(v.canSave).toBe(false);
    });

    it('a failed save shows its reason', () => {
        expect(view(preview(), { error: 'could not write project.json: disk full' }).error).toBe('could not write project.json: disk full');
    });

    it('a finished save says what was written and that git is the next step', () => {
        expect(view(preview(), { saved: ['project.json', '.flows/nightly.json'] }).done).toBe('Saved 2 files. They are ordinary changes in git: review and commit them.');
        expect(view(preview(), { saved: ['project.json'] }).done).toBe('Saved 1 file. It is an ordinary change in git: review and commit it.');
    });
});
