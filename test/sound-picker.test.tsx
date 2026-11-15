// @vitest-environment happy-dom
/**
 * A SOUND IS PICKED FROM A POPOVER, AND EVERY SOUND HAS ITS OWN PLAY BUTTON (Tynn #711; the owner: the native dropdown's
 * play button only played the SELECTED sound, so you had to choose a sound to hear it).
 *
 * The control is a Button naming the current sound. It opens react-fancy's Popover listing the sounds in their groups.
 * Each row has a play button that previews that sound WITHOUT selecting it; clicking the row's name selects it and closes
 * the popover. Keyboard: arrows move, Space plays, Enter selects, Escape closes. Starting a preview stops any other one
 * (the player, renderer/alert-sound.ts). Interaction is a claim about a live DOM, so this renders in happy-dom.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOUND_CHOICES, soundPickerList } from '../src/core/alerts.js';
import { SoundPicker } from '../src/renderer/components/SoundPicker.js';
import { playPreviewSound, stopPreviewSound } from '../src/renderer/alert-sound.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
const selected: string[] = [];
const previewed: string[] = [];

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    selected.length = 0;
    previewed.length = 0;
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

function render(value = 'winddown'): void {
    act(() => root.render(<SoundPicker value={value} label="Sound: an agent asks you something" onSelect={(v) => selected.push(v)} onPreview={(v) => previewed.push(v)} />));
}
const trigger = () => host.querySelector('[data-sound-picker]') as HTMLButtonElement;
const popover = () => document.querySelector('[data-sound-popover]') as HTMLElement | null;
const name = (v: string) => document.querySelector(`[data-sound-name="${v}"]`) as HTMLButtonElement;
const play = (v: string) => document.querySelector(`[data-sound-play="${v}"]`) as HTMLButtonElement;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const open = () => click(trigger());

describe('the control', () => {
    it('is a react-fancy Button naming the current sound, closed until clicked', () => {
        render('winddown');
        expect(trigger().tagName).toBe('BUTTON');
        expect(trigger().hasAttribute('data-react-fancy-button')).toBe(true);
        expect(trigger().textContent).toContain('Wind Down');
        expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
        expect(popover()).toBeNull();
        render('chime-amber');
        expect(trigger().textContent).toContain('Chimes · Amber');
        expect(host.querySelector('select')).toBeNull();
    });
});

describe('the popover', () => {
    it('a click opens it: the sounds in their groups, one row each, Genie first and None last', () => {
        render();
        open();
        expect(popover()).not.toBeNull();
        const groups = [...popover()!.querySelectorAll('[data-sound-group]')].map((e) => e.getAttribute('data-sound-group'));
        expect(groups).toEqual(soundPickerList().map((gr) => gr.label));
        expect(groups.slice(0, 3)).toEqual(['Genie', 'Chimes and confirmations', 'Alerts and errors']);
        const rows = [...popover()!.querySelectorAll('[data-sound-row]')].map((e) => e.getAttribute('data-sound-row'));
        expect(rows).toEqual(SOUND_CHOICES.map((c) => c.value));
        expect(rows.at(-1)).toBe('off');
    });

    it('every sound row has a play button of its own and a name button; the selected row is marked, and only it', () => {
        render('winddown');
        open();
        for (const c of SOUND_CHOICES) {
            expect(name(c.value), c.value).not.toBeNull();
            expect(play(c.value), c.value).not.toBeNull();
            expect(name(c.value).textContent).toContain(c.label);
        }
        const marked = [...popover()!.querySelectorAll('[data-sound-row][data-selected="true"]')].map((e) => e.getAttribute('data-sound-row'));
        expect(marked).toEqual(['winddown']);
        expect(name('winddown').getAttribute('aria-pressed')).toBe('true');
        expect(name('sparkle').getAttribute('aria-pressed')).toBe('false');
    });

    it("a row's play button previews THAT sound without selecting it and leaves the popover open", () => {
        render('winddown');
        open();
        click(play('sparkle'));
        expect(previewed).toEqual(['sparkle']);
        expect(selected).toEqual([]);
        expect(popover()).not.toBeNull();
        expect(trigger().textContent).toContain('Wind Down');
    });

    it('None has nothing to play, so its play button is disabled', () => {
        render();
        open();
        expect(play('off').disabled).toBe(true);
        click(play('off'));
        expect(previewed).toEqual([]);
    });

    it("a click on the row's name selects it and closes the popover", () => {
        render('winddown');
        open();
        click(name('sparkle'));
        expect(selected).toEqual(['sparkle']);
        expect(previewed).toEqual([]);
        expect(popover()).toBeNull();
    });
});

describe('the keyboard', () => {
    it('arrows move between rows, Space plays the focused one, Enter selects it, Escape closes', () => {
        render('winddown');
        open();
        name('winddown').focus();
        key(name('winddown'), 'ArrowDown');
        const order = [...popover()!.querySelectorAll('[data-sound-name]')].map((e) => e.getAttribute('data-sound-name')!);
        const next = order[order.indexOf('winddown') + 1]!;
        expect(document.activeElement).toBe(name(next));
        key(name(next), 'ArrowUp');
        expect(document.activeElement).toBe(name('winddown'));
        key(name(next), ' ');
        expect(previewed).toEqual([next]);
        expect(selected).toEqual([]);
        key(name(next), 'Enter');
        expect(selected).toEqual([next]);
        expect(popover()).toBeNull();
        open();
        expect(popover()).not.toBeNull();
        key(document.body, 'Escape');
        expect(popover()).toBeNull();
    });
});

describe('previews do not pile up (the player)', () => {
    it('starting a preview stops the one before it', () => {
        const made: Array<{ url: string; pause: ReturnType<typeof vi.fn> }> = [];
        class FakeAudio {
            pause = vi.fn();
            currentTime = 0;
            constructor(public url: string) { made.push(this as never); }
            play() { return Promise.resolve(); }
        }
        vi.stubGlobal('Audio', FakeAudio);
        playPreviewSound({ kind: 'wav', file: 'sparkle.wav' });
        playPreviewSound({ kind: 'wav', file: 'winddown.wav' });
        expect(made).toHaveLength(2);
        expect(made[0]!.pause).toHaveBeenCalledTimes(1);
        expect(made[1]!.pause).not.toHaveBeenCalled();
        stopPreviewSound();
        expect(made[1]!.pause).toHaveBeenCalledTimes(1);
    });
});
