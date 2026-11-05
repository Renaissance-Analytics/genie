// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { registerAppIcons } from '../src/renderer/icons.js';
import { control } from './helpers/control-markup.js';

/**
 * THE WORKSPACE HEADER'S TERMINAL BUTTON (Tynn story #378). The owner: "Add a terminal button to the left of the Files
 * button in the workspace header that opens a new window with a terminal in it." A react-fancy Button (the owner's rule
 * for every action), an icon and the word, a tooltip; each click opens another window; while it opens it says so, and a
 * failure is said beside it with Retry.
 *
 * Interaction is a claim about a live DOM, so this file renders in happy-dom (docs/decisions.md D4).
 */

// The app's icons, as the window registers them: an unregistered name draws an empty span (renderer/icons.ts).
registerAppIcons();

type Opened = { ok: true } | { ok: false; reason: string };
const ws = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const files = {} as never;
// Passed loosely ON PURPOSE: before the prop exists, the test is red by its assertions, not by a type error.
const props = (open: () => Promise<Opened>) => ({ onOpenScratchTerminal: open } as Record<string, unknown>);
const header = (html: string) => html.slice(html.indexOf('data-view-header'), html.indexOf('</header>'));

describe('the button, drawn', () => {
    const html = header(renderToStaticMarkup(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} files={files} {...props(async () => ({ ok: true }))} />));

    it('a react-fancy Button with an icon and the word Terminal, and a tooltip', () => {
        const button = control(html, 'data-action="open-scratch-terminal"');
        expect(button).toMatchObject({ tag: 'button', fancy: true, text: 'Terminal' });
        expect(button!.inner).toContain('<svg');
        expect(button!.open).toMatch(/\stitle="[^"]+"/);
    });

    it('it sits immediately left of Files', () => {
        const terminal = html.indexOf('data-action="open-scratch-terminal"');
        const filesAt = html.indexOf('data-action="toggle-files"');
        expect(terminal).toBeGreaterThan(-1);
        expect(filesAt).toBeGreaterThan(terminal);
        // Nothing else that acts sits between them.
        expect(html.slice(terminal, filesAt).match(/data-action="/g)).toHaveLength(1);
    });

    it('CONTROL: a window that cannot open one (no action given) draws no button that would do nothing', () => {
        const without = header(renderToStaticMarkup(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} files={files} />));
        expect(without).toContain('data-action="toggle-files"');
        expect(without).not.toContain('open-scratch-terminal');
    });
});

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const terminalButton = () => host.querySelector('[data-action="open-scratch-terminal"]') as HTMLButtonElement | null;

describe('the button, pressed', () => {
    it('each click asks for a new window (COUNTED: two clicks, two windows)', async () => {
        let calls = 0;
        act(() => root.render(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} files={files} {...props(async () => { calls += 1; return { ok: true }; })} />));
        expect(terminalButton()).not.toBeNull();
        await act(async () => { terminalButton()!.click(); });
        await flush();
        await act(async () => { terminalButton()!.click(); });
        await flush();
        expect(calls).toBe(2);
    });

    it('while it opens, the button says so (busy); a failure is said beside it with Retry, and Retry asks again', async () => {
        let release: (r: Opened) => void = () => {};
        let calls = 0;
        const open = () => { calls += 1; return new Promise<Opened>((resolve) => { release = resolve; }); };
        act(() => root.render(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} files={files} {...props(open)} />));
        await act(async () => { terminalButton()!.click(); });
        expect(terminalButton()!.getAttribute('aria-busy')).toBe('true');
        await act(async () => { release({ ok: false, reason: 'no shell' }); });
        await flush();
        expect(terminalButton()!.getAttribute('aria-busy')).toBeNull();
        const said = host.querySelector('[data-scratch-terminal-error]');
        expect(said?.textContent).toContain('no shell');
        const retry = host.querySelector('[data-action="open-scratch-terminal-retry"]') as HTMLButtonElement | null;
        expect(retry).not.toBeNull();
        expect(retry!.hasAttribute('data-react-fancy-button')).toBe(true);
        await act(async () => { retry!.click(); });
        expect(calls).toBe(2);
        await act(async () => { release({ ok: true }); });
        await flush();
        // Control: the failure is gone once one opened.
        expect(host.querySelector('[data-scratch-terminal-error]')).toBeNull();
    });
});
