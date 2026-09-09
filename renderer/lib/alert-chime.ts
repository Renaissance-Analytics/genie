import type { SynthMotif } from '../../main/notify-sound-kinds';

/**
 * The built-in alert chimes — the notes, and the one place that plays them.
 *
 * Genie ships no audio asset for the default chime: it is synthesized with Web
 * Audio, so it works on a fresh install with nothing to load. That synthesis was
 * written out TWICE — in `master.tsx`, where an alert actually plays, and in
 * `settings.tsx`, behind the Preview button — with nothing checking that Preview
 * played what the alert would. Two motifs and two copies was already one copy
 * too many; eight alert kinds (genie#546) made it worth fixing.
 *
 * The note list is now DATA, which is the part that can be tested without a
 * speaker (`__tests__/alert-chime.test.ts` pins the exact frequencies that
 * shipped). `playChime` is the thin, untestable remainder: it needs a real
 * AudioContext, so it is deliberately as small as it can be.
 */

/** One note. `start` and `dur` are seconds, relative to when the chime begins. */
export interface ChimeTone {
    freq: number;
    start: number;
    dur: number;
    type: OscillatorType;
}

/**
 * When to close the AudioContext for each motif, in ms — comfortably after the
 * last note has decayed. Leaking one context per alert adds up over a session
 * that runs for days.
 */
export const CHIME_CLOSE_MS: Record<SynthMotif, number> = {
    done: 700,
    attention: 900,
};

/**
 * The notes for a motif.
 *
 *   - `done`      E5 → A5, a gentle rise. "The thing you were waiting on ended."
 *   - `attention` A5, A5, D6 on a brighter triangle wave — a fast triple-knock
 *                 that lifts on the last one. Unmistakably NOT the gentle rise:
 *                 "someone needs you NOW."
 */
export function chimeTones(motif: SynthMotif): ChimeTone[] {
    if (motif === 'attention') {
        return [
            { freq: 880, start: 0, dur: 0.1, type: 'triangle' },
            { freq: 880, start: 0.14, dur: 0.1, type: 'triangle' },
            { freq: 1175, start: 0.28, dur: 0.26, type: 'triangle' }, // D6 lift
        ];
    }
    return [
        { freq: 660, start: 0, dur: 0.18, type: 'sine' }, // E5
        { freq: 880, start: 0.16, dur: 0.24, type: 'sine' }, // A5
    ];
}

/**
 * Play a motif through Web Audio. Best-effort and silent on failure — an alert
 * must never be able to throw into whatever it is announcing, and a browser that
 * will not give us an AudioContext is a missing chime, not an error.
 */
export function playChime(motif: SynthMotif): void {
    try {
        const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
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
