/**
 * THE DEFAULT CHIME'S NOTES (Tynn #766; Genie 1's renderer/lib/alert-chime.ts at v0.7.0-beta.342, ported note for note).
 *
 * Genie ships no audio file for it: it is synthesized with Web Audio, so it works on a fresh install with nothing to
 * load. The notes are DATA — the part that can be tested without a speaker (test/alerts.test.ts pins the frequencies
 * Genie 1 shipped); the player (renderer/alert-sound.ts) is the thin, untestable remainder.
 *
 * Two motifs, not one per alert: eight chimes nobody can tell apart are worse for the listener than two they can.
 */
export type ChimeMotif = 'done' | 'attention';

/** One note. `start` and `dur` are seconds, relative to when the chime begins. */
export interface ChimeTone {
    readonly freq: number;
    readonly start: number;
    readonly dur: number;
    readonly type: 'sine' | 'triangle';
}

/** When to close the AudioContext for each motif, in ms — after the last note has decayed. One context per alert leaks over a days-long session. */
export const CHIME_CLOSE_MS: Readonly<Record<ChimeMotif, number>> = { done: 700, attention: 900 };

/**
 * - `done`      E5 → A5, a gentle rise: the thing you were waiting on ended.
 * - `attention` A5, A5, D6 on a brighter triangle wave — a fast triple-knock that lifts on the last one: someone needs
 *               you NOW.
 */
export function chimeTones(motif: ChimeMotif): ChimeTone[] {
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
