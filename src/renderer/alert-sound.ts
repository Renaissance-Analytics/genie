import { CHIME_CLOSE_MS, chimeTones, type ChimeMotif } from '../core/alert-chime.js';
import type { AlertSound } from '../core/alerts.js';

/**
 * THE ONE PLAYER for an alert's sound — the alert itself (App's useAlerts) and Settings' Preview both call it, so Preview
 * plays exactly what the alert will (Genie 1 had two copies of the chime and nothing checking they agreed). What to play
 * is decided in core/alerts.ts and the chime's notes in core/alert-chime.ts; this is the untestable remainder that needs
 * a real speaker. Best-effort and silent on failure: an alert must never throw into what it announces.
 */
export function playAlertSound(sound: AlertSound | null, _volume = 1): void { // RED STUB (Tynn #1022): the gain is not applied yet.
    start(sound);
}

/** A sound that is playing: what stops it. */
interface Playing { stop: () => void }

function start(sound: AlertSound | null): Playing | null {
    if (!sound) return null;
    if (sound.kind === 'synth') return playChime(sound.motif);
    if (sound.kind === 'custom') {
        // Your own file, read by main (the renderer cannot read disk); one that cannot be read plays the kind's own sound.
        let inner: Playing | null = null;
        let stopped = false;
        const fallback = () => { if (!stopped) inner = start(sound.fallback); };
        void customLoader(sound.key).then((data) => { if (stopped) return; if (data) inner = playUrl(data); else fallback(); }).catch(fallback);
        return { stop: () => { stopped = true; inner?.stop(); } };
    }
    return playUrl(new URL(`./sounds/${sound.file}`, import.meta.url).href);
}

/** The preview that is playing now (Tynn #711): at most one, so previewing the next sound stops it. */
let previewing: Playing | null = null;

export function stopPreviewSound(): void {
    const p = previewing;
    previewing = null;
    p?.stop();
}

/** Settings' preview: stops whatever preview is playing, then plays this one. */
export function playPreviewSound(sound: AlertSound | null, _volume = 1): void { // RED STUB (Tynn #1022)
    stopPreviewSound();
    previewing = start(sound);
}

/** How a custom file is read — main's, through the bridge (App sets it once). Until then, none: the fallback plays. */
let customLoader: (key: string) => Promise<string | null> = async () => null;

export function setCustomSoundLoader(load: (key: string) => Promise<string | null>): void {
    customLoader = load;
}

function playUrl(url: string): Playing | null {
    if (typeof Audio === 'undefined') return null;
    const audio = new Audio(url);
    void audio.play().catch(() => { /* autoplay refused: the toast still says it */ });
    return { stop: () => { audio.pause(); audio.currentTime = 0; } };
}

function playChime(motif: ChimeMotif): Playing | null {
    try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx();
        const now = ctx.currentTime;
        for (const t of chimeTones(motif)) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = t.type;
            osc.frequency.value = t.freq;
            gain.gain.setValueAtTime(0.0001, now + t.start);
            gain.gain.exponentialRampToValueAtTime(0.18, now + t.start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + t.start);
            osc.stop(now + t.start + t.dur);
        }
        const close = () => void ctx.close().catch(() => {});
        setTimeout(close, CHIME_CLOSE_MS[motif]);
        return { stop: close };
    } catch {
        /* audio is best-effort */
        return null;
    }
}
