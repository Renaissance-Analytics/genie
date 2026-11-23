// @vitest-environment happy-dom
/**
 * SOUND VOLUME IN SETTINGS → NOTIFICATIONS, AND IN THE PLAYER (Tynn #1022). A master slider with a mute, and an Advanced
 * disclosure listing every alert kind with its own level and a play button. What plays is master × event, applied by the
 * one player (renderer/alert-sound.ts) to a file's `Audio.volume` and to the chime's gain.
 *
 * A CLIENT SETTING (the owner's ruling: "activity sounds is a client setting"): the levels are kept by THIS client, in its
 * own store (renderer/client-sound-settings.ts, the renderer's localStorage), never written to the host. The sound CHOSEN
 * per kind is still read from the settings the block is given.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_KINDS } from '../src/core/alerts.js';
import { playAlertSound, playPreviewSound, stopPreviewSound } from '../src/renderer/alert-sound.js';
import { CLIENT_SOUND_KEY, clientSoundValues, setClientSound, subscribeClientSound } from '../src/renderer/client-sound-settings.js';
import { SoundVolume } from '../src/renderer/components/SoundVolume.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
const previews: Array<{ kind: string; volume: number }> = [];

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    previews.length = 0;
    localStorage.clear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** The block, with THIS client's levels already kept (`client`) and the host's settings it reads the chosen sounds from (`values`). */
function render(client: Record<string, boolean | string> = {}, values: Record<string, boolean | string> = {}): void {
    if (Object.keys(client).length > 0) localStorage.setItem(CLIENT_SOUND_KEY, JSON.stringify(client));
    act(() => root.render(<SoundVolume values={values} onPreview={(kind, volume) => previews.push({ kind, volume })} />));
}
/** What this client keeps, as stored. */
const kept = (): Record<string, unknown> => JSON.parse(localStorage.getItem(CLIENT_SOUND_KEY) ?? '{}') as Record<string, unknown>;
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

describe('the client keeps its own levels', () => {
    it('nothing kept reads as no levels (100%, not muted); what is kept reads back', () => {
        expect(clientSoundValues()).toEqual({});
        setClientSound('alert_volume', '35');
        setClientSound('alert_muted', true);
        setClientSound('alert_levels', '{"mail":20}');
        expect(clientSoundValues()).toEqual({ alert_volume: '35', alert_muted: true, alert_levels: '{"mail":20}' });
        expect(kept()).toEqual({ alert_volume: '35', alert_muted: true, alert_levels: '{"mail":20}' });
    });
    it('a broken store, or a value of the wrong type, reads as nothing kept, never a throw', () => {
        localStorage.setItem(CLIENT_SOUND_KEY, 'not json');
        expect(clientSoundValues()).toEqual({});
        localStorage.setItem(CLIENT_SOUND_KEY, JSON.stringify({ alert_volume: 35, alert_muted: 'yes', alert_levels: '{}', other: 'x' }));
        expect(clientSoundValues()).toEqual({ alert_levels: '{}' });
    });
    it('a change is told to whoever listens — in this window, and from another window of this client (the storage event)', () => {
        const heard: number[] = [];
        const off = subscribeClientSound(() => heard.push(1));
        setClientSound('alert_volume', '40');
        expect(heard).toHaveLength(1);
        localStorage.setItem(CLIENT_SOUND_KEY, JSON.stringify({ alert_volume: '20' }));
        window.dispatchEvent(new StorageEvent('storage', { key: CLIENT_SOUND_KEY }));
        expect(heard).toHaveLength(2);
        // CONTROL: another key's change is not this store's.
        window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
        expect(heard).toHaveLength(2);
        off();
        setClientSound('alert_volume', '10');
        expect(heard).toHaveLength(2);
    });
});

describe('the master control', () => {
    it('is a react-fancy slider at this client’s level (100 when never set), beside a mute Button', () => {
        render();
        expect(range('[data-sound-master]').value).toBe('100');
        act(() => root.unmount());
        root = createRoot(host);
        render({ alert_volume: '35' });
        expect(range('[data-sound-master]').value).toBe('35');
        expect(q('[data-sound-master] [data-react-fancy-slider]')).not.toBeNull();
        const mute = q('[data-action="sound-mute"]')!;
        expect(mute.tagName).toBe('BUTTON');
        expect(mute.hasAttribute('data-react-fancy-button')).toBe(true);
        expect(mute.getAttribute('aria-pressed')).toBe('false');
    });

    it('moving it keeps the level on THIS client once the hand settles (one write per move, not per pixel)', () => {
        vi.useFakeTimers();
        render();
        const input = range('[data-sound-master]');
        slide(input, 80);
        slide(input, 61);
        slide(input, 60);
        expect(input.value).toBe('60');
        expect(kept().alert_volume).toBeUndefined();
        act(() => { vi.advanceTimersByTime(400); });
        expect(kept()).toEqual({ alert_volume: '60' });
    });

    it('a change kept by another window of this client shows here at once', () => {
        render({ alert_volume: '70' });
        expect(range('[data-sound-master]').value).toBe('70');
        act(() => {
            localStorage.setItem(CLIENT_SOUND_KEY, JSON.stringify({ alert_volume: '25' }));
            window.dispatchEvent(new StorageEvent('storage', { key: CLIENT_SOUND_KEY }));
        });
        expect(range('[data-sound-master]').value).toBe('25');
    });

    it('mute is an icon button, INVERTED while on; a click keeps alert_muted on this client; the slider stays where it was', () => {
        render({ alert_muted: true, alert_volume: '70' });
        const mute = q('[data-action="sound-mute"]')!;
        expect(mute.getAttribute('aria-pressed')).toBe('true');
        expect(mute.className).toContain('bg-[var(--selected-bg)]');
        expect(mute.querySelector('svg')).not.toBeNull();
        expect(range('[data-sound-master]').value).toBe('70');
        click(mute);
        expect(kept().alert_muted).toBe(false);
        const unmuted = q('[data-action="sound-mute"]')!;
        // CONTROL: not muted, not inverted.
        expect(unmuted.getAttribute('aria-pressed')).toBe('false');
        expect(unmuted.className).not.toContain('bg-[var(--selected-bg)]');
        click(unmuted);
        expect(kept().alert_muted).toBe(true);
        expect(range('[data-sound-master]').value).toBe('70');
    });
});

describe('a slider a mouse can reach (the first VM proof: the master slider collapsed to nothing and a press at 40% of it landed on its wrapper div)', () => {
    /**
     * react-fancy's Slider, given a label, wraps itself in a Field that does NOT take the Slider's className, and that
     * Field is what sits in the row: a `flex-1` on the Slider never reached the flex item, and a w-full range input gives
     * its Field no width of its own. So each Slider sits in a track of OURS, the row's flex item, which the Field fills.
     */
    const sliders = () => [...host.querySelectorAll('[data-volume-track]')] as HTMLElement[];
    it('every slider — master and each level — sits in its own track: the row’s flex item, growing, with a minimum width (COUNTED: 1 + 26)', () => {
        render({});
        click(q('[data-action="sound-levels-toggle"]')!);
        expect(sliders()).toHaveLength(1 + ALERT_KINDS.length);
        expect(host.querySelectorAll('[data-react-fancy-slider]')).toHaveLength(1 + ALERT_KINDS.length);
        for (const s of sliders()) {
            expect(s.querySelector('[data-react-fancy-slider] input[type="range"]')).not.toBeNull();
            // The track is a direct child of its row, so it IS the flex item.
            expect(s.parentElement!.matches('[data-sound-master], [data-sound-level]')).toBe(true);
            expect(s.className).toContain('min-w-40');
            expect(s.className).toContain('flex-1');
            expect(s.className).not.toContain('min-w-0');
        }
    });
    it('the range input’s hit box is taller than its drawn track (h-5), so a press near the line still lands on it', () => {
        render({});
        click(q('[data-action="sound-levels-toggle"]')!);
        // COUNTED, so it cannot pass over no tracks at all (it did, against the collapsing layout, in 1122-020349-0faba7).
        expect(sliders()).toHaveLength(1 + ALERT_KINDS.length);
        for (const s of sliders()) expect(s.className).toContain('[&_input]:h-5');
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

    it('a kind shows this client’s level; moving it keeps alert_levels on this client with that kind, the others kept', () => {
        vi.useFakeTimers();
        render({ alert_levels: '{"mail":20,"finished":40}' });
        click(q('[data-action="sound-levels-toggle"]')!);
        expect(range('[data-sound-level="finished"]').value).toBe('40');
        expect(range('[data-sound-level="question"]').value).toBe('100');
        slide(range('[data-sound-level="finished"]'), 75);
        act(() => { vi.advanceTimersByTime(400); });
        expect(JSON.parse(String(kept().alert_levels))).toEqual({ mail: 20, finished: 75 });
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
        render({}, { sound_finished: 'off' });
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
