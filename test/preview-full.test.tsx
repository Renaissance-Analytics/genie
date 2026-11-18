import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { questionWindowAction } from '../src/core/keys.js';
import { previewFullClass, previewFullKey } from '../src/core/preview-full.js';
import { ICON_NAMES } from '../src/renderer/icons.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { PreviewFullFrame } from '../src/renderer/components/PreviewFull.js';
import { QuestionApp, type QuestionAppView } from '../src/renderer/components/QuestionApp.js';

/**
 * A FILE PREVIEW CAN FILL ITS WINDOW (the owner, beta.65, a screenshot of the ForceTheQuestion window with a spec open
 * in the drawer beside the question: "a full-screen button for file previews, to make reading specs easier").
 *
 * One control for every file preview: a react-fancy icon Button beside the preview's own buttons. It makes the preview
 * fill its WINDOW below the window's drag strip (the question window's header, the main window's title bar). It does not
 * cover the strip: Chromium keeps a drag region live under an overlay, so buttons drawn over it would drag the window
 * instead of answering a click (genie#1298 is the rule that the strip is the window's one app region). Esc or the same
 * button restores it. The preview is the SAME element in both states, only its class changes: nothing remounts (an
 * editor keeps its cursor), and the pane's box stays in the layout, so nothing beside it moves.
 */
const press = (key: string, mod: { ctrl?: boolean; shift?: boolean } = {}) => ({ key, ctrlKey: mod.ctrl ?? false, metaKey: false, altKey: false, shiftKey: mod.shift ?? false, typing: false });

describe('the key and the size (core/preview-full.ts)', () => {
    it('Esc restores a preview that fills its window', () => {
        expect(previewFullKey(press('Escape'), true)).toBe('restore');
    });

    it('CONTROL: not full, a modified Esc, or another key — not the preview’s', () => {
        expect(previewFullKey(press('Escape'), false)).toBeNull();
        expect(previewFullKey(press('Escape', { ctrl: true }), true)).toBeNull();
        expect(previewFullKey(press('Escape', { shift: true }), true)).toBeNull();
        expect(previewFullKey(press('Enter'), true)).toBeNull();
    });

    it('full = fixed, edge to edge, below the window’s drag strip (question header h-11, main title bar h-9)', () => {
        const q = previewFullClass('question').split(/\s+/);
        expect(q).toEqual(expect.arrayContaining(['fixed', 'inset-x-0', 'bottom-0', 'top-11']));
        const m = previewFullClass('main').split(/\s+/);
        expect(m).toEqual(expect.arrayContaining(['fixed', 'inset-x-0', 'bottom-0', 'top-9']));
        expect(q).not.toContain('inset-0');
    });
});

describe('Esc in the question window: the full preview first, then the drawer, then Later', () => {
    it('a full drawer is restored before anything is closed', () => {
        expect(questionWindowAction(press('Escape'), { drawerOpen: true, drawerFull: true })).toBe('restore-preview');
    });

    it('CONTROL: as before when the drawer is not full', () => {
        expect(questionWindowAction(press('Escape'), { drawerOpen: true, drawerFull: false })).toBe('close-drawer');
        expect(questionWindowAction(press('Escape'), { drawerOpen: false })).toBe('later');
    });
});

const item = {
    id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'atlas', workspaceId: 'tynn', title: 'Spec', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Spec', question: 'Does `.ai/plans/spec.md` hold?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem;
const view: QuestionAppView = { item, waiting: 0 };
const ask = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<QuestionApp view={view} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} now={10_000} existing={null} onOpenFile={() => {}} onCloseFile={() => {}} onDrawerFull={() => {}} {...extra} />);
const MD = { path: '.ai/plans/spec.md', text: '# Spec\n\nIt **holds**.', line: null };
const tagOf = (html: string, attr: string): string => new RegExp(`<[^>]*${attr}[^>]*>`).exec(html)?.[0] ?? '';

describe('the question window’s file drawer', () => {
    it('a full-window icon Button beside Close: not pressed, named, keyboard-reachable', () => {
        const html = ask({ drawer: MD });
        const btn = tagOf(html, 'data-action="preview-full"');
        expect(btn).toMatch(/^<button/);
        expect(btn).toContain('aria-pressed="false"');
        expect(btn).toMatch(/aria-label="Fill the window"/);
        expect(btn).not.toContain('tabindex="-1"');
        // Beside Close, in the drawer's header.
        expect(html).toMatch(/data-action="preview-full"[\s\S]*?data-action="question-drawer-close"|data-action="question-drawer-close"[\s\S]*?data-action="preview-full"/);
    });

    it('full: the drawer’s content fills the window below the header; the aside keeps its width (nothing beside it moves)', () => {
        const html = ask({ drawer: MD, drawerFull: true });
        const frame = tagOf(html, 'data-preview-full="on"');
        expect(frame).toContain('fixed');
        expect(frame).toContain('top-11');
        expect(tagOf(html, 'data-question-drawer=')).toContain('w-[520px]');
        const btn = tagOf(html, 'data-action="preview-full"');
        expect(btn).toContain('aria-pressed="true"');
        expect(btn).toMatch(/aria-label="Restore"/);
        expect(btn).toContain('aria-keyshortcuts="Escape"');
        // The file is still there, drawn once.
        expect(html.match(/<strong>holds<\/strong>/g)).toHaveLength(1);
    });

    it('an image in the drawer gets the same control', () => {
        const html = ask({ drawer: { path: 'shots/a.png', media: { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' }, line: null } });
        expect(html).toContain('data-action="preview-full"');
    });

    it('CONTROL: no drawer, no control', () => {
        expect(ask()).not.toContain('data-action="preview-full"');
    });

    it('the window’s Esc hands the full state to the key and restores on restore-preview', () => {
        const source = readFileSync('src/renderer/components/QuestionApp.tsx', 'utf8');
        expect(source).toMatch(/questionWindowAction\([^)]*\)?[^;]*drawerFull/);
        expect(source).toMatch(/=== 'restore-preview'\)\s*\{?\s*[^}]*onDrawerFull\?\.\(false\)/);
    });
});

const files: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['docs/spec.md'],
    open: { ok: true, path: 'docs/spec.md', text: '# Spec\n', sha: 'x' },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};

describe('the Files viewer', () => {
    it('the open file’s crumb carries the control; the column is a full frame, not full yet', () => {
        const html = renderToStaticMarkup(<FilesPanel {...files} />);
        expect(html).toMatch(/data-file-crumb="docs\/spec.md"[\s\S]*?data-action="preview-full"/);
        expect(html).toContain('data-preview-full="off"');
    });

    it('an image tab too', () => {
        const html = renderToStaticMarkup(<FilesPanel {...files} tabs={['a.png']} open={{ ok: true, path: 'a.png', text: '', sha: 'x', src: 'data:image/png;base64,iVBORw0KGgo=' }} />);
        expect(html).toContain('data-action="preview-full"');
    });

    it('the frame, full in the main window: fixed below the title bar', () => {
        const html = renderToStaticMarkup(<PreviewFullFrame full window="main" className="flex min-h-0 flex-1 flex-col"><p>x</p></PreviewFullFrame>);
        const frame = tagOf(html, 'data-preview-full="on"');
        expect(frame).toContain('fixed');
        expect(frame).toContain('top-9');
    });

    it('Esc restores it from anywhere in the window, ahead of the window’s own Esc (capture phase)', () => {
        const source = readFileSync('src/renderer/components/PreviewFull.tsx', 'utf8');
        expect(source).toMatch(/addEventListener\('keydown',[^)]*,\s*(true|\{\s*capture:\s*true\s*\})\)/);
        expect(source).toContain('previewFullKey(');
        expect(readFileSync('src/renderer/components/FilesPanel.tsx', 'utf8')).toContain('usePreviewFull(');
    });
});

describe('icons', () => {
    it('both of the control’s icons are registered (an unregistered name draws nothing)', () => {
        expect(ICON_NAMES).toEqual(expect.arrayContaining(['maximize-2', 'minimize-2']));
    });
});
