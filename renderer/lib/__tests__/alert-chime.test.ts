import { describe, expect, it } from 'vitest';
import { chimeTones, CHIME_CLOSE_MS } from '../alert-chime';
import { ALERT_KINDS, alertKindDef } from '../../../main/notify-sound-kinds';

/**
 * The built-in chimes, as DATA (genie#546).
 *
 * The two Web Audio motifs were written out twice — once in `master.tsx`, where
 * an alert plays, and once in `settings.tsx`, behind the Preview button — with
 * no way to check that Preview played what the alert would. Eight alert kinds
 * would have made that two copies of a decision taken eight times.
 *
 * Extracting the note list makes it assertable without audio: these tests pin
 * the exact frequencies that shipped in beta.309, so "refactor" here means the
 * same sound, not a similar one.
 */

describe('the two motifs are actually distinguishable', () => {
    it('gives `done` the gentle rising two-note figure', () => {
        expect(chimeTones('done')).toEqual([
            { freq: 660, start: 0, dur: 0.18, type: 'sine' },
            { freq: 880, start: 0.16, dur: 0.24, type: 'sine' },
        ]);
    });

    it('gives `attention` the fast triple-knock that lifts on the last one', () => {
        expect(chimeTones('attention')).toEqual([
            { freq: 880, start: 0, dur: 0.1, type: 'triangle' },
            { freq: 880, start: 0.14, dur: 0.1, type: 'triangle' },
            { freq: 1175, start: 0.28, dur: 0.26, type: 'triangle' },
        ]);
    });

    it('differs in note count, waveform AND pitch — not just one of them', () => {
        // A person hears these through laptop speakers while looking at
        // something else. Two motifs that differ only in a semitone are one
        // motif with extra code.
        const done = chimeTones('done');
        const attn = chimeTones('attention');
        expect(done.length).not.toBe(attn.length);
        expect(new Set(done.map((t) => t.type))).not.toEqual(
            new Set(attn.map((t) => t.type)),
        );
        expect(Math.max(...attn.map((t) => t.freq))).toBeGreaterThan(
            Math.max(...done.map((t) => t.freq)),
        );
    });

    it('closes its AudioContext after the last note has finished sounding', () => {
        // A leaked AudioContext per alert is a real cost in a long Genie session.
        for (const motif of ['done', 'attention'] as const) {
            const end = Math.max(...chimeTones(motif).map((t) => t.start + t.dur));
            expect(CHIME_CLOSE_MS[motif] / 1000).toBeGreaterThan(end);
        }
    });
});

describe('every alert kind has a chime to play', () => {
    it('resolves a note list for the motif of each registered kind', () => {
        for (const kind of ALERT_KINDS) {
            const tones = chimeTones(alertKindDef(kind).motif);
            expect(tones.length, `${kind} has no tones`).toBeGreaterThan(0);
        }
    });
});
