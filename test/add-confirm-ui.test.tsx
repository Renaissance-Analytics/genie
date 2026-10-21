import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddWorkspacePreview, type AddPreviewView } from '../src/renderer/components/AddWorkspacePreview.js';

/**
 * THE CONFIRM BUTTON WHILE AN ADD RUNS, AND WHERE THE PERSON LANDS (parity rows 25 and 38; the controller itself is
 * test/add-confirm.test.ts). Genie 1's confirm buttons said what was happening and could not be pressed twice; Genie 2's
 * "Clone and add" stayed live through a clone that can take minutes. And New opened the workspace it made while Import
 * from Git, Import from Tynn and Open existing only closed the plan.
 */

describe('the confirm button while the add runs', () => {
    const steps = [{ action: 'register in Genie', path: '/w/x', writes: false }];
    const git: AddPreviewView = { ok: true, source: 'git', url: 'https://github.com/example/fancy-ui.git', parent: '/w', path: '/w/fancy-ui', kind: 'simple-repo', steps };
    const tynn: AddPreviewView = { ok: true, source: 'tynn', project: { id: '42', name: 'Tynn.ai', slug: 'tynn', vision: null }, host: 'https://tynn.ai', parent: '/w', path: '/w/tynn.agi', kind: 'empty', steps };
    const folder: AddPreviewView = { ok: true, path: '/w/repo', kind: 'simple-repo', steps };
    const button = (html: string) => html.match(/<button[^>]*data-action="confirm-add"[^>]*>[^<]*<\/button>/)?.[0] ?? '';

    it.each([
        ['git', git, 'Clone and add', 'Cloning…'],
        ['tynn', tynn, 'Create and add', 'Creating…'],
        ['folder', folder, 'Add this workspace', 'Adding…'],
    ] as const)('%s: disabled and saying what it is doing while busy; live and named as before when not', (_name, preview, idle, working) => {
        const still = button(renderToStaticMarkup(<AddWorkspacePreview preview={preview} busy={false} onConfirm={() => {}} onCancel={() => {}} />));
        // Positive control: the same button, not busy, is found, live, and carries its ordinary label.
        expect(still).toContain(idle);
        expect(still).not.toMatch(/ disabled=""/);
        const busy = button(renderToStaticMarkup(<AddWorkspacePreview preview={preview} busy onConfirm={() => {}} onCancel={() => {}} />));
        expect(busy).toContain(working);
        expect(busy).not.toContain(idle);
        expect(busy).toMatch(/ disabled=""/);
    });
});

describe('App wiring', () => {
    // Read as text: App.tsx cannot be rendered here. Each confirm of the three non-New sources goes through the ONE
    // confirmer (so all three get the busy state and open the workspace), and the Shell hands the busy state down.
    const app = readFileSync('src/renderer/App.tsx', 'utf8').replace(/\r\n/g, '\n');
    const shell = readFileSync('src/renderer/Shell.tsx', 'utf8').replace(/\r\n/g, '\n');

    it.each([
        ['onConfirmAdd', 'workspaces.confirmAdd('],
        ['onConfirmAddGit', 'workspaces.confirmAddFromGit('],
        ['onConfirmAddTynn', 'workspaces.confirmAddFromTynn('],
    ])('%s runs %s through the confirmer', (prop, call) => {
        const line = app.split('\n').find((l) => l.trimStart().startsWith(`${prop}={`)) ?? '';
        // Positive control: the handler's line is found at all.
        expect(line).toContain(call);
        expect(line).toContain('confirmAddOnce(');
    });

    it('the Shell passes the busy state to the plan', () => {
        expect(app).toMatch(/addBusy=\{addBusy\}/);
        expect(shell).toMatch(/<AddWorkspacePreview[^\n]*busy=\{addBusy/);
    });
});
