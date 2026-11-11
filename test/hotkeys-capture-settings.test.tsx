// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/*
 * ONE WAY TO SET A KEY ON SETTINGS → KEYBOARD (Tynn issue #697, the coordinator's ruling): the Command Window key and the
 * ForceTheQuestion nudge key are set with the same capture control as the send key. Same refusals, same Reset; what is
 * stored does not change (an accelerator, empty for Genie's default).
 */
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
let el: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); });

function page(values: Record<string, string> = {}) {
    const onAction = vi.fn();
    act(() => root.render(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={onAction} onNavigate={() => {}} section="keyboard" />));
    const control = (name: string) => el.querySelector(`[data-hotkey-capture="${name}"]`) as HTMLButtonElement;
    const press = (name: string, init: KeyboardEventInit) => act(() => { control(name).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
    const start = (name: string) => act(() => { control(name).click(); });
    return { onAction, control, press, start };
}

const KEYS: Array<{ name: string; setting: string; fresh: KeyboardEventInit; stored: string; taken: KeyboardEventInit; takenBy: RegExp }> = [
    { name: 'commandWindow', setting: 'command_window_hotkey', fresh: { key: 'p', ctrlKey: true, shiftKey: true }, stored: 'CommandOrControl+Shift+P', taken: { key: 'F5' }, takenBy: /ForceTheQuestion/ },
    { name: 'ftqNudge', setting: 'ftq_nudge_hotkey', fresh: { key: 'F6' }, stored: 'F6', taken: { key: 'k', ctrlKey: true }, takenBy: /Command Window/ },
];

describe.each(KEYS)('$name', (k) => {
    it('capture: click, "Press the keys…", and the next combination is stored as its accelerator', () => {
        const p = page();
        p.start(k.name);
        expect(p.control(k.name).textContent).toContain('Press the keys…');
        p.press(k.name, k.fresh);
        expect(p.onAction).toHaveBeenCalledExactlyOnceWith({ kind: 'settings.set', key: k.setting, value: k.stored });
    });

    it('cancel: Escape stores nothing', () => {
        const p = page();
        p.start(k.name);
        p.press(k.name, { key: 'Escape' });
        expect(p.onAction).not.toHaveBeenCalled();
        expect(p.control(k.name).textContent).not.toContain('Press the keys…');
    });

    it('refusal: a key Genie already uses is refused in words, and nothing is stored', () => {
        const p = page();
        p.start(k.name);
        p.press(k.name, k.taken);
        expect(p.onAction).not.toHaveBeenCalled();
        expect(el.querySelector('[data-hotkey-refused]')?.textContent).toMatch(k.takenBy);
    });

    it('refusal: a bare typing key', () => {
        const p = page();
        p.start(k.name);
        p.press(k.name, { key: 'a' });
        expect(p.onAction).not.toHaveBeenCalled();
        expect(el.querySelector('[data-hotkey-refused]')?.textContent).toMatch(/typing/i);
    });

    it('Reset: only for a key that is not Genie\'s default, and it stores empty', () => {
        expect(page().control(k.name).closest('[data-hotkey-control]')!.querySelector('[data-hotkey-reset]')).toBeNull();
        const p = page({ [k.setting]: k.stored });
        act(() => { (el.querySelector(`[data-hotkey-reset="${k.name}"]`) as HTMLButtonElement).click(); });
        expect(p.onAction).toHaveBeenCalledExactlyOnceWith({ kind: 'settings.set', key: k.setting, value: '' });
    });

    it('pressing Genie\'s own default for it stores empty, as before (CONTROL: the stored value is unchanged)', () => {
        const p = page({ [k.setting]: k.stored });
        p.start(k.name);
        p.press(k.name, k.name === 'commandWindow' ? { key: 'k', ctrlKey: true } : { key: 'F5' });
        expect(p.onAction).toHaveBeenCalledExactlyOnceWith({ kind: 'settings.set', key: k.setting, value: '' });
    });
});

describe('a stored key Genie cannot read', () => {
    it('says the shortcut is off, and the control invites a new key', () => {
        const p = page({ ftq_nudge_hotkey: 'Hyper+Nope+' });
        expect(el.textContent).toContain('this shortcut is off until you set it again');
        expect(p.control('ftqNudge').textContent).toContain('Set a key');
    });
});

describe('the wiring', () => {
    it('Genie\'s own keys do not fire while one is being captured', () => {
        expect(readFileSync('src/renderer/App.tsx', 'utf8')).toContain(`[data-hotkey-capture][data-capturing="true"]`);
    });
});
