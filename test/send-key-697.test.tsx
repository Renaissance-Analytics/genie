// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE COMPOSER'S SEND KEY (Tynn issue #697; the owner, 2026-11-11): "I want to swap the user input send key to enter. let
 * shift+enter be the way to add a new line. In the customization settings the user should be able to set this hotkey (not
 * by typing it, but by using a real set hotkey ux that captures the key pressed once activated)."
 *
 * Loaded by computed paths on purpose: before the modules exist these are red by assertion, not by an import error.
 */
const load = async (path: string): Promise<Record<string, unknown>> => (await import(/* @vite-ignore */ path).catch(() => ({}))) as Record<string, unknown>;
const core = await load('../src/core/send-key.js');
const store = await load('../src/renderer/send-key-store.js');
const captureModule = await load('../src/renderer/components/HotkeyCapture.js');
const fn = <T,>(mod: Record<string, unknown>, name: string): T => { expect(mod[name], name).toBeDefined(); return mod[name] as T; };

interface Press { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }
type ComposerKey = (press: Press, sendKey: string, state?: { listOpen?: boolean }) => 'send' | 'newline' | null;
const MOD_ENTER = 'CommandOrControl+Enter';

describe('what a key does in a composer', () => {
    const key = () => fn<ComposerKey>(core, 'composerKey');
    const sendKeyFrom = () => fn<(values: Record<string, unknown> | null) => string>(core, 'sendKeyFrom');

    it('by default Enter sends and Shift+Enter is a new line', () => {
        const send = sendKeyFrom()({});
        expect(send).toBe('Enter');
        expect(key()({ key: 'Enter' }, send)).toBe('send');
        expect(key()({ key: 'Enter', shiftKey: true }, send)).toBe('newline');
        expect(fn<(s: string) => string>(core, 'newlineKeyFor')(send)).toBe('Shift+Enter');
    });

    it('swapped to Ctrl/Cmd+Enter: that sends, and Enter is a new line', () => {
        expect(key()({ key: 'Enter', ctrlKey: true }, MOD_ENTER)).toBe('send');
        expect(key()({ key: 'Enter', metaKey: true }, MOD_ENTER)).toBe('send');
        expect(key()({ key: 'Enter' }, MOD_ENTER)).toBe('newline');
        expect(fn<(s: string) => string>(core, 'newlineKeyFor')(MOD_ENTER)).toBe('Enter');
    });

    it('Enter while an IME is composing never sends', () => {
        expect(key()({ key: 'Enter', isComposing: true }, 'Enter')).toBeNull();
        expect(key()({ key: 'Enter', keyCode: 229 }, 'Enter')).toBeNull();
        // CONTROL: the same press outside a composition sends.
        expect(key()({ key: 'Enter', keyCode: 13 }, 'Enter')).toBe('send');
    });

    it('Enter with a command or mention list open picks the item: it is not the composer\'s', () => {
        expect(key()({ key: 'Enter' }, 'Enter', { listOpen: true })).toBeNull();
        expect(key()({ key: 'Enter' }, 'Enter', { listOpen: false })).toBe('send');
    });

    it('any other key is not the composer\'s (CONTROL)', () => {
        expect(key()({ key: 'a' }, 'Enter')).toBeNull();
    });

    it('a stored value Genie cannot read falls back to Enter', () => {
        expect(sendKeyFrom()({ send_key: 'Hyper+Nope+' })).toBe('Enter');
        expect(sendKeyFrom()({ send_key: MOD_ENTER })).toBe(MOD_ENTER);
        expect(sendKeyFrom()(null)).toBe('Enter');
    });

    it('the hint names both keys as they are now (drawn inside the composer since Tynn #641)', () => {
        const hint = fn<(sendKey: string, platform: string) => string>(core, 'sendKeyHint');
        expect(hint('Enter', 'generic')).toBe('Enter to send · Shift+Enter for a new line');
        expect(hint(MOD_ENTER, 'generic')).toBe('Ctrl+Enter to send · Enter for a new line');
        expect(hint(MOD_ENTER, 'darwin')).toBe('⌘+Enter to send · Enter for a new line');
    });
});

describe('a key that cannot be the send key is refused in words', () => {
    const problem = (accelerator: string) => fn<(accelerator: string, bindings: unknown, prompts: unknown, platform: string) => string | null>(core, 'sendKeyProblem')(accelerator, { commandWindow: 'CommandOrControl+K', ftqNudge: 'F5' }, [], 'generic');

    it.each(['Enter', MOD_ENTER, 'Shift+Enter', 'Alt+Enter'])('%s can be it (CONTROL)', (accelerator) => {
        expect(problem(accelerator)).toBeNull();
    });
    it('a bare printable key', () => {
        expect(problem('A')).toMatch(/typing/i);
        expect(problem('Space')).toMatch(/typing/i);
    });
    it('a key that edits or leaves the text', () => {
        for (const k of ['Backspace', 'Tab', 'Escape', 'ArrowUp']) expect(problem(k), k).toEqual(expect.any(String));
    });
    it('one Genie already uses', () => {
        expect(problem('CommandOrControl+K')).toMatch(/Command Window/);
        expect(problem('F5')).toMatch(/ForceTheQuestion/);
    });
    it('one the system uses', () => {
        expect(problem('Alt+F4')).toMatch(/system|Windows|computer/i);
        expect(problem('Alt+Tab')).toEqual(expect.any(String));
    });
});

// Settings records with the kit's HotkeyCapture (react-fancy 6.20+, Tynn #637); Genie's wrapper keeps what is stored, its
// refusals and its Reset. The composer takes the key itself (PromptInput `submitKey`), so Genie's boundary is gone.
describe('the capture control', () => {
    const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
    let el: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
    afterEach(() => { act(() => root.unmount()); el.remove(); (store['setSendKey'] as ((k: string) => void) | undefined)?.('Enter'); });
    const press = (target: Element, init: KeyboardEventInit): KeyboardEvent => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); act(() => { target.dispatchEvent(e); }); return e; };

    type CaptureProps = { value: string; platform: string; label: string; onCapture: (accelerator: string) => string | null; onReset?: () => void };
    const Capture = () => fn<(p: CaptureProps) => React.ReactElement>(captureModule, 'HotkeyCapture');
    const mountCapture = (props: Partial<CaptureProps> = {}) => {
        const C = Capture();
        const onCapture = vi.fn((_: string): string | null => null);
        act(() => root.render(<C value="Enter" platform="generic" label="Send message" onCapture={onCapture} {...props} />));
        const button = () => el.querySelector('[data-hotkey-capture] [data-react-fancy-hotkey-capture-trigger]') as HTMLButtonElement;
        return { onCapture: (props.onCapture as typeof onCapture | undefined) ?? onCapture, button };
    };
    // The kit's chord: one <kbd>, a <span> per cap, the "+" between them aria-hidden.
    const caps = () => [...el.querySelectorAll('[data-hotkey-capture] kbd > span:not([aria-hidden])')].map((k) => k.textContent);
    it('is the kit’s control, holding the stored key as the kit’s string', () => {
        mountCapture({ value: MOD_ENTER });
        expect(el.querySelector('[data-hotkey-capture] [data-react-fancy-hotkey-capture]')?.getAttribute('data-value')).toBe('ctrl+enter');
    });


    it('shows the key as keycaps; clicked, it reads "Press the keys…"', () => {
        const c = mountCapture({ value: MOD_ENTER });
        expect(caps()).toEqual(['Ctrl', 'Enter']);
        act(() => { c.button().click(); });
        expect(c.button().textContent).toContain('Press the keys…');
    });

    it('the next combination pressed is captured, once', () => {
        const c = mountCapture();
        act(() => { c.button().click(); });
        press(c.button(), { key: 'Control', ctrlKey: true });
        expect(c.onCapture).not.toHaveBeenCalled();
        const e = press(c.button(), { key: 'Enter', code: 'Enter', ctrlKey: true });
        expect(c.onCapture).toHaveBeenCalledExactlyOnceWith(MOD_ENTER);
        expect(e.defaultPrevented).toBe(true);
        expect(c.button().textContent).not.toContain('Press the keys…');
        // No longer capturing: a later key is not taken.
        press(c.button(), { key: 'x', code: 'KeyX', altKey: true });
        expect(c.onCapture).toHaveBeenCalledTimes(1);
    });

    it('Escape cancels and captures nothing', () => {
        const c = mountCapture();
        act(() => { c.button().click(); });
        press(c.button(), { key: 'Escape' });
        expect(c.onCapture).not.toHaveBeenCalled();
        expect(c.button().textContent).not.toContain('Press the keys…');
        expect(caps()).toEqual(['Enter']);
    });

    it('a refused combination says why, in words, and the key shown stays', () => {
        const c = mountCapture({ onCapture: vi.fn(() => 'That key is used for typing.') });
        act(() => { c.button().click(); });
        press(c.button(), { key: 'a', code: 'KeyA' });
        expect(el.querySelector('[data-hotkey-refused]')?.textContent).toBe('That key is used for typing.');
        expect(caps()).toEqual(['Enter']);
    });

    it('Reset to default is beside it when given', () => {
        const onReset = vi.fn();
        mountCapture({ onReset });
        act(() => { (el.querySelector('[data-hotkey-reset]') as HTMLButtonElement).click(); });
        expect(onReset).toHaveBeenCalledOnce();
    });

    it('a change in Settings reaches the open composer: the store the composer reads is updated', () => {
        fn<(k: string) => void>(store, 'setSendKey')('Alt+S');
        expect(fn<() => string>(store, 'sendKeyNow')()).toBe('Alt+S');
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('the setting exists, kept on this machine, with Enter as its default', () => {
        expect(src('src/core/settings.ts')).toMatch(/\{ key: 'send_key', group: 'general', scope: 'device',[^\n]*default: '',[^\n]*hidden: true \}/);
    });
    it('every composer a person writes to an agent in follows it', () => {
        expect(src('src/renderer/components/ChatFlyout.tsx')).toContain('submitKey={toHotkey(sendKey, keysPlatform)}');
        expect(src('src/renderer/components/InboxFlyout.tsx')).toContain('composerKey(');
        expect(src('src/renderer/components/MobileShell.tsx')).toContain('composerKey(');
    });
    it('the app feeds the stored key to open composers, and Settings has the control', () => {
        expect(src('src/renderer/App.tsx')).toMatch(/setSendKey\(sendKeyFrom\(features\.settings\.values\)\)/);
        expect(src('src/renderer/components/FeatureSurfaces.tsx')).toContain('<HotkeyCapture');
    });
});
