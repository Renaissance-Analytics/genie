// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveDialogView, type SaveDialogView } from '../src/core/save-dialog-view.js';
import type { MergeDecision, SavePlan, SavePreview } from '../src/core/workspace-save.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { SaveToRepoView } from '../src/renderer/components/SaveToRepoDialog.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { control } from './helpers/control-markup.js';

/**
 * SAVE TO REPO, WHAT A PERSON SEES (Tynn #756 UI): a "Save to repo" react-fancy Button in the workspace dashboard's header
 * (one click from the workspace), and a dialog with each file's diff status, what teammates changed, and a conflict's
 * yours-or-theirs choice. Save stays disabled until every conflict is settled; a guard refusal names each field; a failed
 * fetch is a warning that does not block. Interaction is a claim about a live DOM, so the clicks render in happy-dom.
 */

const okPlan: SavePlan = { ok: true, files: [{ path: 'project.json', text: '{}' }], backups: [], stampedTo: null };
const preview = (over: Partial<SavePreview> = {}): SavePreview => ({ plan: okPlan, files: [{ path: 'project.json', status: 'changed' }], upstream: { fetched: true, ref: 'origin/main' }, decisions: [], conflicts: [], ...over });
const d = (id: string, kind: MergeDecision['kind'], local: unknown, incoming: unknown): MergeDecision => ({ id, kind, base: undefined, local, incoming });
const viewOf = (p: SavePreview, choices: Record<string, 'local' | 'incoming'> = {}): SaveDialogView => saveDialogView({ preview: p, choices, busy: false, error: null, saved: null });
const conflicts = () => preview({ decisions: [d('project.json#sites/a1', 'conflict', { n: 1 }, { n: 2 })], conflicts: ['project.json#sites/a1'] });

const noop = () => {};
const markup = (view: SaveDialogView) => renderToStaticMarkup(<SaveToRepoView workspaceName="Acme" view={view} onChoose={noop} onSave={noop} onClose={noop} />);

describe('the dialog, as markup', () => {
    it('Save is a react-fancy Button, enabled when there is something to save and nothing to settle', () => {
        const save = control(markup(viewOf(preview())), 'data-action="save-to-repo-confirm"');
        expect(save).toMatchObject({ tag: 'button', fancy: true, text: 'Save' });
        expect(save!.open).not.toMatch(/\sdisabled(=|\s|>)/);
    });

    it('Save is DISABLED while a conflict is unsettled, and the note says how many', () => {
        const html = markup(viewOf(conflicts()));
        expect(control(html, 'data-action="save-to-repo-confirm"')!.open).toMatch(/\sdisabled(=|\s|>)/);
        expect(html).toContain('Choose yours or theirs for 1 conflict before saving.');
    });

    it('each conflict offers Mine and Theirs as react-fancy Buttons, the chosen one pressed, with both values shown', () => {
        const html = markup(viewOf(conflicts(), { 'project.json#sites/a1': 'incoming' }));
        const mine = control(html, 'data-save-choice="local"');
        const theirs = control(html, 'data-save-choice="incoming"');
        expect(mine).toMatchObject({ fancy: true, text: 'Mine' });
        expect(theirs).toMatchObject({ fancy: true, text: 'Theirs' });
        expect(mine!.open).toContain('aria-pressed="false"');
        expect(theirs!.open).toContain('aria-pressed="true"');
        expect(html).toContain('{&quot;n&quot;:1}');
        expect(html).toContain('{&quot;n&quot;:2}');
        expect(control(html, 'data-action="save-to-repo-confirm"')!.open).not.toMatch(/\sdisabled(=|\s|>)/);
    });

    it('lists each file with its status in words, and what teammates changed', () => {
        const html = markup(viewOf(preview({ files: [{ path: '.flows/nightly.json', status: 'added' }, { path: 'project.json', status: 'changed' }], decisions: [d('project.json#sites/b2', 'incoming', undefined, { n: 1 })] })));
        expect(html).toContain('data-save-file=".flows/nightly.json"');
        expect(html).toMatch(/Flow: nightly[\s\S]*New/);
        expect(html).toContain('data-save-file="project.json"');
        expect(html).toContain('data-save-incoming="project.json#sites/b2"');
        expect(html).toContain('Site b2');
    });

    it('a guard refusal names every field and offers no way to save', () => {
        const refused = preview({
            plan: { ok: false, reason: 'Nothing was saved.', violations: [{ path: 'project.json.sites.k1.command[5]', rule: 'absolute-path', reason: 'project.json.sites.k1.command[5] holds an absolute path' }] },
            files: [],
        });
        const html = markup(viewOf(refused));
        expect(html).toContain('data-save-field="project.json.sites.k1.command[5]"');
        expect(html).toContain('holds an absolute path');
        expect(control(html, 'data-action="save-to-repo-confirm"')!.open).toMatch(/\sdisabled(=|\s|>)/);
    });

    it('a failed fetch is a warning, and Save is still enabled', () => {
        const html = markup(viewOf(preview({ upstream: { fetched: false, ref: 'origin/main', reason: 'could not resolve host' } })));
        expect(html).toMatch(/data-save-warning=""[^>]*>[\s\S]*could not resolve host/);
        expect(control(html, 'data-action="save-to-repo-confirm"')!.open).not.toMatch(/\sdisabled(=|\s|>)/);
    });

    it('CONTROL: a good fetch shows no warning', () => {
        expect(markup(viewOf(preview()))).not.toContain('data-save-warning');
    });

    it('a finished save says what happened', () => {
        const html = markup(saveDialogView({ preview: preview(), choices: {}, busy: false, error: null, saved: ['project.json'] }));
        expect(html).toContain('Saved 1 file.');
    });
});

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

describe('the dialog, pressed', () => {
    it('Mine and Theirs report which conflict and which side', () => {
        const heard: [string, string][] = [];
        act(() => root.render(<SaveToRepoView workspaceName="Acme" view={viewOf(conflicts())} onChoose={(id, side) => heard.push([id, side])} onSave={noop} onClose={noop} />));
        act(() => { (host.querySelector('[data-save-choice="incoming"]') as HTMLButtonElement).click(); });
        act(() => { (host.querySelector('[data-save-choice="local"]') as HTMLButtonElement).click(); });
        expect(heard).toEqual([['project.json#sites/a1', 'incoming'], ['project.json#sites/a1', 'local']]);
    });

    it('an enabled Save asks to save once; a disabled one asks for nothing (CONTROL)', () => {
        let saves = 0;
        act(() => root.render(<SaveToRepoView workspaceName="Acme" view={viewOf(preview())} onChoose={noop} onSave={() => { saves += 1; }} onClose={noop} />));
        act(() => { (host.querySelector('[data-action="save-to-repo-confirm"]') as HTMLButtonElement).click(); });
        expect(saves).toBe(1);
        act(() => root.render(<SaveToRepoView workspaceName="Acme" view={viewOf(conflicts())} onChoose={noop} onSave={() => { saves += 1; }} onClose={noop} />));
        act(() => { (host.querySelector('[data-action="save-to-repo-confirm"]') as HTMLButtonElement).click(); });
        expect(saves).toBe(1);
    });
});

describe('the workspace dashboard header', () => {
    const workspace = { id: 'acme', name: 'Acme', path: '/w/acme' };
    const html = (extra: { onSaveToRepo?: () => void } = {}) => renderToStaticMarkup(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} rows={[]} deckItems={[]} onAddAgent={noop} {...extra} />);

    it('has a "Save to repo" react-fancy Button in the header row, beside Add agent', () => {
        const h = html({ onSaveToRepo: noop });
        expect(control(h, 'data-action="save-to-repo"')).toMatchObject({ tag: 'button', fancy: true, text: 'Save to repo' });
        const head = h.slice(h.indexOf('data-dash-header=""'));
        const row = head.slice(0, head.indexOf('</div>'));
        expect(row).toContain('data-action="save-to-repo"');
        expect(row).toContain('data-action="add-agent"');
    });

    it('CONTROL: without a way to save (an older host) there is no button', () => {
        expect(html()).not.toContain('data-action="save-to-repo"');
    });

    it('pressing it asks to save to the repo once', () => {
        let asked = 0;
        act(() => root.render(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} rows={[]} deckItems={[]} onAddAgent={noop} onSaveToRepo={() => { asked += 1; }} />));
        const button = host.querySelector('[data-workspace-dashboard] [data-action="save-to-repo"]') as HTMLButtonElement | null;
        expect(button).not.toBeNull();
        act(() => { button!.click(); });
        expect(asked).toBe(1);
    });
});
