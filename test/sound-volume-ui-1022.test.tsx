// @vitest-environment happy-dom
/**
 * SOUND VOLUME IN SETTINGS → NOTIFICATIONS, AND IN THE PLAYER (Tynn #1022). A master slider with a mute, and an Advanced
 * disclosure listing every alert kind with its own level and a play button. What plays is master × event, applied by the
 * one player (renderer/alert-sound.ts) to a file's `Audio.volume` and to the chime's gain. Writes are host settings.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_KINDS } from '../src/core/alerts.js';
import { playAlertSound, playPreviewSound, stopPreviewSound } from '../src/renderer/alert-sound.js';
import { SoundVolume } from '../src/renderer/components/SoundVolume.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
type Action = { kind: string; key?: string; value?: unknown };
const actions: Action[] = [];
const previews: Array<{ kind: string; volume: number }> = [];

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    actions.length = 0;
    previews.length = 0;
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function render(values: Record<string, boolean | string>): void {
    act(() => root.render(<SoundVolume values={values} onAction={(a) => actions.push(a as Action)} onPreview={(kind, volume) => previews.push({ kind, volume })} />));
}
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
/** A person moving a range input: React reads the value through the native setter, then the input event. */
function slide(input: HTMLInputElement, value: number): void {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const range = (sel: string) => q(`${sel} input[type="range"]`) as HTMLInputElement;

describe('the master control', () => {
    it('is a react-fancy slider at the saved level (100 when never set), beside a mute Button', () => {
        render({});
        expect(range('[data-sound-master]').value).toBe('100');
        render({ alert_volume: '35' });
        expect(range('[data-sound-master]').value).toBe('35');
        expect(q('[data-sound-master] [data-react-fancy-slider]')).not.toBeNull();
        const mute = q('[data-action="sound-mute"]')!;
        expect(mute.tagName).toBe('BUTTON');
        expect(mute.hasAttribute('data-react-fancy-button')).toBe(true);
        expect(mute.getAttribute('aria-pressed')).toBe('false');
    });

    it('moving it writes alert_volume to the host once the hand settles (one write per move, not per pixel)', () => {
        vi.useFakeTimers();
        render({ alert_volume: '100' });
        const input = range('[data-sound-master]');
        slide(input, 80);
        slide(input, 61);
        slide(input, 60);
        expect(input.value).toBe('60');
        expect(actions.filter((a) => a.key === 'alert_volume')).toEqual([]);
        act(() => { vi.advanceTimersByTime(400); });
        expect(actions.filter((a) => a.key === 'alert_volume')).toEqual([{ kind: 'settings.set', key: 'alert_volume', value: '60' }]);
    });

    it('mute is an icon button, INVERTED while on; a click writes alert_muted; the slider stays where it was', () => {
        render({ alert_muted: true, alert_volume: '70' });
        const mute = q('[data-action="sound-mute"]')!;
        expect(mute.getAttribute('aria-pressed')).toBe('true');
        expect(mute.className).toContain('bg-[var(--selected-bg)]');
        expect(mute.querySelector('svg')).not.toBeNull();
        expect(range('[data-sound-master]').value).toBe('70');
        click(mute);
        expect(actions).toContainEqual({ kind: 'settings.set', key: 'alert_muted', value: false });
        render({ alert_muted: false });
        const unmuted = q('[data-action="sound-mute"]')!;
        // CONTROL: not muted, not inverted.
        expect(unmuted.className).not.toContain('bg-[var(--selected-bg)]');
        click(unmuted);
        expect(actions).toContainEqual({ kind: 'settings.set', key: 'alert_muted', value: true });
    });
});

describe('a slider a mouse can reach (the first VM proof: in a narrow Settings pane the master slider collapsed to nothing beside its two fixed buttons, and a press at 40% of it landed on its wrapper div)', () => {
    const sliders = () => [...host.querySelectorAll('[data-react-fancy-slider]')] as HTMLElement[];
    it('every slider — master and each level — keeps a minimum width, never min-w-0 (COUNTED: 1 + 26)', () => {
        render({});
        click(q('[data-action="sound-levels-toggle"]')!);
        expect(sliders()).toHaveLength(1 + ALERT_KINDS.length);
        for (const s of sliders()) {
            expect(s.className).toContain('min-w-40');
            expect(s.className).not.toContain('min-w-0');
        }
    });
    it('the range input’s hit box is taller than its drawn track (h-5), so a press near the line still lands on it', () => {
        render({});
        click(q('[data-action="sound-levels-toggle"]')!);
        for (const s of sliders()) expect(s.className).toContain('[&_input[type=range]]:h-5');
    });
    it('a row wraps rather than squeezing its slider: the master row and each level row are flex-wrap', () => {
        render({});
        click(q('[data-action="sound-levels-toggle"]')!);
        expect(q('[data-sound-master]')!.className).toContain('flex-wrap');
        for (const k of ALERT_KINDS) expect(q(`[data-sound-level="${k.kind}"]`)!.className, k.kind).toContain('flex-wrap');
    });
});

describe('Advanced: a level per event', () => {
    it('is closed until its disclosure is clicked, then lists EVERY alert kind (COUNTED) with a slider and a play button', () => {
        render({});
        const toggle = q('[data-action="sound-levels-toggle"]')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(q('[data-sound-levels]')).toBeNull();
        click(toggle);
        expect(q('[data-action="sound-levels-toggle"]')!.getAttribute('aria-expanded')).toBe('true');
        expect(q('[data-action="sound-levels-toggle"]')!.className).toContain('bg-[var(--selected-bg)]');
        const rows = [...host.querySelectorAll('[data-sound-level]')].map((r) => r.getAttribute('data-sound-level'));
        expect(rows).toEqual(ALERT_KINDS.map((k) => k.kind));
        for (const k of ALERT_KINDS) {
            expect(range(`[data-sound-level="${k.kind}"]`).value, k.kind).toBe('100');
            expect(q(`[data-sound-level-play="${k.kind}"]`), k.kind).not.toBeNull();
        }
    });

    it('a kind shows its saved level; moving it writes alert_levels with that kind and keeps the others', () => {
        vi.useFakeTimers();
        render({ alert_levels: '{"mail":20,"finished":40}' });
        click(q('[data-action="sound-levels-toggle"]')!);
        expect(range('[data-sound-level="finished"]').value).toBe('40');
        expect(range('[data-sound-level="question"]').value).toBe('100');
        slide(range('[data-sound-level="finished"]'), 75);
        act(() => { vi.advanceTimersByTime(400); });
        const write = actions.find((a) => a.key === 'alert_levels')!;
        expect(write.kind).toBe('settings.set');
        expect(JSON.parse(String(write.value))).toEqual({ mail: 20, finished: 75 });
    });

    it('a play button previews that kind at master × its level, even while muted', () => {
        render({ alert_muted: true, alert_volume: '50', alert_levels: '{"finished":40}' });
        click(q('[data-action="sound-levels-toggle"]')!);
        click(q('[data-sound-level-play="finished"]')!);
        expect(previews).toHaveLength(1);
        expect(previews[0]!.kind).toBe('finished');
        expect(previews[0]!.volume).toBeCloseTo(0.2);
    });

    it('a kind set to None has nothing to preview: its play button is disabled (CONTROL: a kind with a sound is not)', () => {
        render({ sound_finished: 'off' });
        click(q('[data-action="sound-levels-toggle"]')!);
        expect((q('[data-sound-level-play="finished"]') as HTMLButtonElement).disabled).toBe(true);
        expect((q('[data-sound-level-play="question"]') as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('the player applies the volume', () => {
    class FakeAudio {
        static made: FakeAudio[] = [];
        volume = 1;
        currentTime = 0;
        constructor(public url: string) { FakeAudio.made.push(this); }
        play() { return Promise.resolve(); }
        pause() {}
    }
    beforeEach(() => { FakeAudio.made = []; vi.stubGlobal('Audio', FakeAudio); });

    it('a file plays at the gain it is given; CONTROL: no gain given is full volume', () => {
        playAlertSound({ kind: 'wav', file: 'sparkle.wav' }, 0.25);
        playAlertSound({ kind: 'wav', file: 'sparkle.wav' });
        expect(FakeAudio.made.map((a) => a.volume)).toEqual([0.25, 1]);
    });

    it('a gain of 0 (muted) plays nothing at all', () => {
        playAlertSound({ kind: 'wav', file: 'sparkle.wav' }, 0);
        expect(FakeAudio.made).toHaveLength(0);
    });

    it('a preview plays at its gain too', () => {
        playPreviewSound({ kind: 'wav', file: 'winddown.wav' }, 0.4);
        expect(FakeAudio.made[0]!.volume).toBeCloseTo(0.4);
        stopPreviewSound();
    });

    it('the Default chime peaks at its own level times the gain', () => {
        const peaks: number[] = [];
        class FakeCtx {
            currentTime = 0;
            destination = {};
            createOscillator() { return { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} }; }
            createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime: (v: number) => { peaks.push(v); } }, connect: (n: unknown) => n }; }
            close() { return Promise.resolve(); }
        }
        vi.stubGlobal('AudioContext', FakeCtx);
        (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
        playAlertSound({ kind: 'synth', motif: 'done' }, 0.5);
        const half = Math.max(...peaks);
        peaks.length = 0;
        playAlertSound({ kind: 'synth', motif: 'done' }, 1);
        const full = Math.max(...peaks);
        expect(full).toBeCloseTo(0.18);
        expect(half).toBeCloseTo(0.09);
    });
});
