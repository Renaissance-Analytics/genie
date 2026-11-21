// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { questionWindowAction } from '../src/core/keys.js';
import { askWindowMaximized, askWindowRestored } from '../src/core/question-maximize.js';
import { ICON_NAMES } from '../src/renderer/icons.js';
import { questionBridge, type QuestionPreload } from '../src/renderer/question-bridge.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';
import { DeckRow } from '../src/renderer/components/DeckRow.js';

/**
 * THE WHOLE QUESTION CAN BE MAXIMIZED (Tynn #1019; the owner, 2026-11-21, on a long question with two image previews in
 * the small ForceTheQuestion window: "make sure that FTQ windows can be maximized, not just image previews in it").
 *
 * - The question window's header has a maximize control (a react-fancy icon Button with a tooltip). It grows the WINDOW to
 *   its display's work area — the body, the visuals, the options and the answer with it — and Restore puts back the bounds
 *   it had. Esc restores before it is Later.
 * - The state is the window's: a push (another question asked, a draft kept) leaves it as it is.
 * - In the Deck the same question expands into an overlay that fills the main window below its title bar; its control, or
 *   Esc, restores it, and the form in it is the same element (nothing typed is lost).
 */
const press = (key: string, mod: { ctrl?: boolean; shift?: boolean } = {}) => ({ key, ctrlKey: mod.ctrl ?? false, metaKey: false, altKey: false, shiftKey: mod.shift ?? false, typing: false });

const item = {
    id: 'q1', source: 'agent-question', agentId: 'agent_q1', agentName: 'b-mo', workspaceId: 'ws_1', workspaceName: 'Tynn.ai', title: 'Push s28', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Push', question: 'Push s28 now?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem;

describe('Esc restores first, then closes (core/keys.ts)', () => {
    it('a maximized window is restored before Esc is Later', () => {
        expect(questionWindowAction(press('Escape'), { drawerOpen: false, maximized: true })).toBe('restore-window');
        expect(questionWindowAction(press('Escape'), { drawerOpen: false, maximized: false })).toBe('later');
    });

    it('a preview filling the window is put back before the window is; the window before the drawer closes', () => {
        expect(questionWindowAction(press('Escape'), { drawerOpen: true, drawerFull: true, maximized: true })).toBe('restore-preview');
        expect(questionWindowAction(press('Escape'), { drawerOpen: true, drawerFull: false, maximized: true })).toBe('restore-window');
        expect(questionWindowAction(press('Escape'), { drawerOpen: true, maximized: false })).toBe('close-drawer');
    });

    it('CONTROL: a modified Esc is not the window’s, maximized or not', () => {
        expect(questionWindowAction(press('Escape', { shift: true }), { drawerOpen: false, maximized: true })).toBeNull();
    });
});

describe('the window’s size (core/question-maximize.ts)', () => {
    const workArea = { x: 1920, y: 0, width: 2560, height: 1400 };
    const saved = { x: 2900, y: 400, width: 560, height: 520 };

    it('maximized is the work area of the display the window is on', () => {
        expect(askWindowMaximized(workArea)).toEqual(workArea);
    });

    it('restore puts back the bounds it had', () => {
        expect(askWindowRestored({ saved, workArea, drawerOpen: false, drawerOpenWhenSaved: false, baseWidth: null })).toEqual({ bounds: saved, baseWidth: null });
    });

    it('a drawer opened while maximized is open after Restore: the saved window widened for it, centred', () => {
        const r = askWindowRestored({ saved, workArea, drawerOpen: true, drawerOpenWhenSaved: false, baseWidth: null });
        expect(r.bounds.width).toBe(560 + 520);
        expect(r.bounds.x).toBe(1920 + Math.round((2560 - 1080) / 2));
        expect(r.bounds.y).toBe(400);
        expect(r.baseWidth).toBe(560);
    });

    it('a drawer closed while maximized is closed after Restore: back to the width it had before the drawer', () => {
        const wide = { ...saved, width: 1080 };
        const r = askWindowRestored({ saved: wide, workArea, drawerOpen: false, drawerOpenWhenSaved: true, baseWidth: 560 });
        expect(r.bounds.width).toBe(560);
        expect(r.baseWidth).toBeNull();
    });

    it('saved bounds no longer on the display are brought back onto it', () => {
        const r = askWindowRestored({ saved: { x: 9000, y: 3000, width: 560, height: 520 }, workArea, drawerOpen: false, drawerOpenWhenSaved: false, baseWidth: null });
        expect(r.bounds.x).toBe(1920 + 2560 - 560);
        expect(r.bounds.y).toBe(1400 - 520);
    });
});

describe('the question window', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    function Harness({ onLater, onMaximize }: { onLater: () => void; onMaximize: (on: boolean) => void }) {
        const [maximized, setMaximized] = useState(false);
        return <QuestionApp view={{ item, waiting: 0 }} sending={false} refusal={null} onAnswer={() => {}} onLater={onLater} onDismiss={() => {}} maximized={maximized} onMaximize={(on) => { onMaximize(on); setMaximized(on); }} />;
    }
    const button = () => host.querySelector<HTMLButtonElement>('[data-question-drag] [data-action="question-maximize"]');
    const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });

    it('the header has a maximize icon button with a tooltip, outside the drag region; it maximizes, restores, and Esc restores before Later', () => {
        const onLater = vi.fn();
        const onMaximize = vi.fn();
        act(() => root.render(<Harness onLater={onLater} onMaximize={onMaximize} />));
        const b = button();
        expect(b).not.toBeNull();
        expect(b!.getAttribute('aria-pressed')).toBe('false');
        expect(b!.getAttribute('title')).toBe('Maximize');
        expect(b!.getAttribute('aria-label')).toBe('Maximize');
        expect(b!.querySelector('svg')).not.toBeNull();
        expect(host.querySelector('[data-question-window]')!.getAttribute('data-question-maximized')).toBe('off');

        act(() => b!.click());
        expect(onMaximize).toHaveBeenLastCalledWith(true);
        expect(button()!.getAttribute('aria-pressed')).toBe('true');
        expect(button()!.getAttribute('title')).toBe('Restore (Esc)');
        expect(host.querySelector('[data-question-window]')!.getAttribute('data-question-maximized')).toBe('on');
        // The question uses the room: the form is no longer held to its reading column.
        expect(host.querySelector('[data-deck-form]')!.className).not.toContain('max-w-[72ch]');

        esc();
        expect(onMaximize).toHaveBeenLastCalledWith(false);
        expect(onLater).not.toHaveBeenCalled();
        expect(button()!.getAttribute('aria-pressed')).toBe('false');
        expect(host.querySelector('[data-deck-form]')!.className).toContain('max-w-[72ch]');

        esc();
        expect(onLater).toHaveBeenCalledTimes(1);
    });

    it('in the drag strip, the button is exempt from the drag (no-drag on the button itself), as the strip’s rule says', () => {
        // Server markup, as the window's other app-region tests read it: the style attribute is written out whole.
        const html = renderToStaticMarkup(<QuestionApp view={{ item, waiting: 0 }} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} onMaximize={() => {}} />);
        const tag = html.match(/<button[^>]*data-action="question-maximize"[^>]*>/)?.[0] ?? '';
        expect(tag).not.toBe('');
        expect(tag).toMatch(/style="[^"]*-webkit-app-region:[ ]*no-drag/);
    });

    it('the button restores too', () => {
        const onMaximize = vi.fn();
        act(() => root.render(<Harness onLater={() => {}} onMaximize={onMaximize} />));
        act(() => button()!.click());
        act(() => button()!.click());
        expect(onMaximize.mock.calls.map((c) => c[0])).toEqual([true, false]);
    });

    it('its icons are registered', () => {
        expect(ICON_NAMES).toContain('maximize-2');
        expect(ICON_NAMES).toContain('minimize-2');
    });
});

describe('the window grows in main, and stays so while it is open', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    it('the bridge hands maximize to the preload', async () => {
        const maximize = vi.fn(async () => {});
        const preload = { current: async () => null, later: async () => {}, onShow: () => () => {}, remote: async () => ({}), maximize } as unknown as QuestionPreload;
        const bridge = questionBridge(preload, () => { throw new Error('no protocol needed'); });
        await bridge.maximize?.(true);
        expect(maximize).toHaveBeenCalledWith(true);
    });

    it('the preload calls question:maximize; main answers it with the work area and the saved bounds, and forgets them on close', () => {
        expect(strip('../src/main/question-preload.ts')).toMatch(/maximize:\s*\(on: boolean\)\s*=>\s*ipcRenderer\.invoke\('question:maximize', on\)/);
        const main = strip('../src/main/question-window-electron.ts');
        expect(main).toMatch(/ipcMain\.handle\('question:maximize'/);
        expect(main).toContain('askWindowMaximized(');
        expect(main).toContain('askWindowRestored(');
        expect(main).toMatch(/win\.on\('closed'[^\n]*restoreTo = null/);
    });

    it('the page keeps the state for the window, not per push, and sends it to main', () => {
        const page = strip('../src/renderer/question-main.tsx');
        expect(page).toMatch(/const \[maximized, setMaximized\] = useState\(false\)/);
        expect(page).toMatch(/onMaximize=\{\(on\) => \{\s*setMaximized\(on\);\s*void bridge\.maximize\?\.\(on\);/);
        // A push sets the view and the drafts; it never touches the size.
        expect(page.slice(page.indexOf('const receive'), page.indexOf('void bridge.current()'))).not.toContain('setMaximized');
    });
});

describe('the Deck', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('a question in the Deck expands to fill the window below the title bar, and Esc or the button restores it; the form is the same element', () => {
        const onEsc = vi.fn();
        window.addEventListener('keydown', onEsc);
        act(() => root.render(<DeckRow item={item} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onAnswerForm={() => {}} formRefusal={null} focusId={null} focusRef={{ current: null }} now={0} />));
        const frame = () => host.querySelector<HTMLElement>(`[data-deck-question-max="${item.id}"]`)!;
        const b = () => frame().querySelector<HTMLButtonElement>('[data-action="deck-question-maximize"]')!;
        expect(frame().getAttribute('data-maximized')).toBe('off');
        expect(b().getAttribute('title')).toBe('Maximize');
        expect(b().querySelector('svg')).not.toBeNull();
        const form = frame().querySelector('[data-deck-form]');

        act(() => b().click());
        expect(frame().getAttribute('data-maximized')).toBe('on');
        expect(frame().className).toMatch(/\bfixed\b/);
        expect(frame().className).toContain('top-9');
        expect(frame().className).toContain('overflow-y-auto');
        expect(b().getAttribute('title')).toBe('Restore (Esc)');
        expect(frame().querySelector('[data-deck-form]')).toBe(form);

        // A key goes to what has focus (the body here) and bubbles up to the window, as in the app.
        act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(frame().getAttribute('data-maximized')).toBe('off');
        // Esc restored it, and nothing else in the window saw that Esc.
        expect(onEsc).not.toHaveBeenCalled();
        expect(frame().querySelector('[data-deck-form]')).toBe(form);

        act(() => b().click());
        act(() => b().click());
        expect(frame().getAttribute('data-maximized')).toBe('off');
        window.removeEventListener('keydown', onEsc);
    });
});
