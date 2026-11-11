// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddWorkspacePreview } from '../src/renderer/components/AddWorkspacePreview.js';
import { TynnProjectPicker } from '../src/renderer/components/TynnProjectPicker.js';
import { tynnPlanner } from '../src/renderer/tynn-plan.js';

/**
 * IMPORTING A WORKSPACE FROM TYNN IS NEVER SILENT (Tynn #688; the owner, beta.61: "picked the folder, and nothing happened.
 * No progress, no workspace, no error"). After the folder is picked Genie reads the plan from the host. Until now that call
 * showed nothing while it ran, a failure of it was dropped (`void … .then(…)` with no rejection handler), and its answer —
 * the plan or a refusal — was drawn at the top of a page the person had scrolled down to find their project in, with
 * nothing bringing it into view.
 */
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

function rig() {
    const seen: string[] = [];
    const deps = {
        setPlanning: (p: { projectId: string; parent: string } | null) => { seen.push(p ? `planning ${p.projectId} in ${p.parent}` : 'planning done'); },
        setPick: () => { seen.push('picker closed'); },
        setPreview: (p: { ok: boolean; reason?: string }) => { seen.push(p.ok ? 'plan shown' : `refused: ${p.reason}`); },
        setRetry: (r: { projectId: string; parent: string } | null) => { seen.push(r ? `retry ${r.projectId} in ${r.parent}` : 'no retry'); },
    };
    return { seen, plan: tynnPlanner(() => deps) };
}

describe('reading the plan after the folder is picked', () => {
    it('shows progress at once, then the plan', async () => {
        const { seen, plan } = rig();
        let answer!: (p: { ok: true }) => void;
        plan(() => new Promise((r) => { answer = r; }), 'p1', 'C:/work');
        expect(seen).toEqual(['planning p1 in C:/work']);
        answer({ ok: true });
        await flush();
        expect(seen).toEqual(['planning p1 in C:/work', 'retry p1 in C:/work', 'picker closed', 'plan shown', 'planning done']);
    });

    it('a call that REJECTS is said in words, with a way to try again; never dropped', async () => {
        const { seen, plan } = rig();
        plan(() => Promise.reject(new Error('the host did not answer')), 'p1', 'C:/work');
        await flush();
        expect(seen).toEqual(['planning p1 in C:/work', 'retry p1 in C:/work', 'picker closed', 'refused: the host did not answer', 'planning done']);
    });

    it('a refusal the host answered is shown with the same way to try again', async () => {
        const { seen, plan } = rig();
        plan(async () => ({ ok: false, reason: 'Tynn lists no project p1 for you' }), 'p1', 'C:/work');
        await flush();
        expect(seen).toContain('retry p1 in C:/work');
        expect(seen).toContain('refused: Tynn lists no project p1 for you');
    });

    it('a Genie that cannot read a plan says so', async () => {
        const { seen, plan } = rig();
        plan(undefined, 'p1', 'C:/work');
        await flush();
        expect(seen.join('|')).toMatch(/refused: This Genie cannot read a Tynn project’s plan/);
    });

    it('one at a time: a second pick while one is being read starts nothing', async () => {
        const { plan } = rig();
        const run = vi.fn(() => new Promise<{ ok: true }>(() => {}));
        plan(run, 'p1', 'C:/work');
        plan(run, 'p2', 'C:/work');
        expect(run).toHaveBeenCalledTimes(1);
    });
});

const projects = { ok: true as const, host: 'https://tynn.ai', projects: [{ id: 'p1', name: 'Alpha', slug: 'alpha' }, { id: 'p2', name: 'Beta', slug: 'beta' }] as never };

describe('what the person sees', () => {
    it('while the plan is read: the picked project says so, and nothing else can be picked', () => {
        const html = renderToStaticMarkup(<TynnProjectPicker state={projects} planning="p1" onPick={() => {}} onCancel={() => {}} />);
        expect(html).toMatch(/data-tynn-planning="p1"/);
        expect(html).toContain('Reading Alpha’s plan');
        expect(html.match(/<button[^>]*data-tynn-project="p2"[^>]*>/)?.[0]).toMatch(/disabled/);
    });

    it('CONTROL: not reading a plan, nothing says so and every project can be picked', () => {
        const html = renderToStaticMarkup(<TynnProjectPicker state={projects} onPick={() => {}} onCancel={() => {}} />);
        expect(html).not.toContain('data-tynn-planning');
        expect(html.match(/<button[^>]*data-tynn-project="p2"[^>]*>/)?.[0]).not.toMatch(/disabled/);
    });

    it('a failure has Try again beside its words', () => {
        const html = renderToStaticMarkup(<AddWorkspacePreview preview={{ ok: false, reason: 'git clone failed: no route to host' }} onConfirm={() => {}} onCancel={() => {}} onRetry={() => {}} />);
        expect(html).toContain('git clone failed: no route to host');
        expect(html).toMatch(/data-action="retry-add"[^>]*>(?:<[^>]+>)*Try again/);
    });

    it('CONTROL: a refusal with nothing to try again has no such button', () => {
        const html = renderToStaticMarkup(<AddWorkspacePreview preview={{ ok: false, reason: 'no' }} onConfirm={() => {}} onCancel={() => {}} />);
        expect(html).not.toContain('retry-add');
    });
});

describe('the answer is brought into view', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLElement;
    let root: Root;
    const scrolled: string[] = [];
    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        scrolled.length = 0;
        Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute('data-add-preview') ?? this.getAttribute('data-tynn-picker') ?? 'other'); };
    });
    afterEach(() => { act(() => { root.unmount(); }); host.remove(); });

    it('the plan or refusal, when it appears (the page may be scrolled far below it)', () => {
        act(() => { root.render(<AddWorkspacePreview preview={{ ok: false, reason: 'no' }} onConfirm={() => {}} onCancel={() => {}} />); });
        expect(scrolled).toEqual(['refused']);
    });

    it('the project list, when it appears', () => {
        act(() => { root.render(<TynnProjectPicker state={projects} onPick={() => {}} onCancel={() => {}} />); });
        expect(scrolled).toEqual(['']);
    });
});

describe('the window is wired to it', () => {
    it('App reads the plan through the planner, shows its progress, and offers the retry', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).not.toMatch(/void resolvedBridge\?\.workspaces\.previewAddFromTynn\(/);
        expect(app).toMatch(/planTynn\(resolvedBridge\?\.workspaces\.previewAddFromTynn \? \(\) => resolvedBridge\.workspaces\.previewAddFromTynn\(projectId, parent\) : undefined, projectId, parent\)/);
        expect(app).toMatch(/tynnPlanning=\{tynnPlanning\?\.projectId \?\? null\}/);
        expect(app).toMatch(/onRetryAdd=\{tynnRetry \? \(\) => \{/);
        // The folder dialog failing is said too.
        expect(app).toMatch(/Where should the Tynn envelope be created\? Pick the parent folder', addStart\)\.then\([^\n]*, sayAddFailed\);/);
    });
});
