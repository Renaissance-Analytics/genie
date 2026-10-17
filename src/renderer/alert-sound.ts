import { CHIME_CLOSE_MS, chimeTones, type ChimeMotif } from '../core/alert-chime.js';
import type { AlertSound } from '../core/alerts.js';

/**
 * THE ONE PLAYER for an alert's sound — the alert itself (App's useAlerts) and Settings' Preview both call it, so Preview
 * plays exactly what the alert will (Genie 1 had two copies of the chime and nothing checking they agreed). What to play
 * is decided in core/alerts.ts and the chime's notes in core/alert-chime.ts; this is the untestable remainder that needs
 * a real speaker. Best-effort and silent on failure: an alert must never throw into what it announces.
 */
export function playAlertSound(sound: AlertSound | null): void {
    if (!sound) return;
    if (sound.kind === 'synth') { playChime(sound.motif); return; }
    if (sound.kind === 'custom') {
        // Your own file, read by main (the renderer cannot read disk); one that cannot be read plays the kind's own sound.
        void customLoader(sound.key).then((data) => (data ? playUrl(data) : playAlertSound(sound.fallback))).catch(() => playAlertSound(sound.fallback));
        return;
    }
    playUrl(new URL(`./sounds/${sound.file}`, import.meta.url).href);
}

/** How a custom file is read — main's, through the bridge (App sets it once). Until then, none: the fallback plays. */
let customLoader: (key: string) => Promise<string | null> = async () => null;

export function setCustomSoundLoader(load: (key: string) => Promise<string | null>): void {
    customLoader = load;
}

function playUrl(url: string): void {
    if (typeof Audio === 'undefined') return;
    void new Audio(url).play().catch(() => { /* autoplay refused: the toast still says it */ });
}

function playChime(motif: ChimeMotif): void {
    try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
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
        setTimeout(() => void ctx.close().catch(() => {}), CHIME_CLOSE_MS[motif]);
    } catch {
        /* audio is best-effort */
    }
}
