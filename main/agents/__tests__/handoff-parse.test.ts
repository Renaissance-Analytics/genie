import { describe, expect, it } from 'vitest';
import { renderHandoff } from '../handoff';
import { parseHandoff } from '../handoff-parse';

/**
 * The handoff is the best "what happened while I was away" artifact Genie has,
 * and it has never been read by anything human-facing — `readHandoff` has no
 * production caller at all. Putting it on a surface means turning the rendered
 * note back into the two facts a surface needs: the agent's prose, and when it
 * was written.
 *
 * The load-bearing test is the ROUND TRIP against the real `renderHandoff`. A
 * parser pinned to a hand-written fixture drifts silently the moment the writer
 * changes its heading or its wording, and the symptom would be a blank handoff
 * card rather than an error. Feeding it the actual writer's output means a format
 * change breaks this file loudly instead.
 */

describe('round trip with the real writer', () => {
    it('recovers the note and the time from what renderHandoff produces', () => {
        const at = new Date('2026-10-04T18:30:00.000Z');
        const parsed = parseHandoff(
            renderHandoff({ agentName: 'kai', note: 'Landed #770. The win32 test still fails.', at }),
        );
        expect(parsed).toEqual({ text: 'Landed #770. The win32 test still fails.', at: at.getTime() });
    });

    it('keeps a multi-paragraph note intact, including its blank lines', () => {
        const note = 'Landed #770.\n\nStill open:\n- the win32 failure\n- the flaky shard';
        const parsed = parseHandoff(renderHandoff({ agentName: 'kai', note }));
        expect(parsed?.text).toBe(note);
    });

    it('does not keep the heading or the byline as part of the note', () => {
        // Those are chrome this file wrote, not words the agent chose. A card that
        // renders them puts "# Handoff — kai" in the middle of the transcript.
        const parsed = parseHandoff(renderHandoff({ agentName: 'kai', note: 'done' }));
        expect(parsed?.text).toBe('done');
    });

    it('survives an agent name with markdown or an em dash in it', () => {
        // The heading is `# Handoff — <name>`, so a name containing an em dash or a
        // `_` could confuse a parser that scans for those characters.
        const parsed = parseHandoff(
            renderHandoff({ agentName: 'kai — the_second', note: 'fine' }),
        );
        expect(parsed?.text).toBe('fine');
    });
});

describe('line endings and lookalikes', () => {
    it('reads a CRLF note without leaving a stray carriage return on every line', () => {
        // The file is written by Genie and edited by whatever the owner opened it
        // in. This repo has already paid for line-ending assumptions once —
        // genie#517, source guards anchored on \n that were inert on CRLF.
        const crlf = '# Handoff — kai\r\n\r\n_Left at 2026-10-04T18:30:00.000Z by the previous run of this agent._\r\n\r\nfirst line\r\nsecond line\r\n';
        expect(parseHandoff(crlf)).toEqual({
            text: 'first line\nsecond line',
            at: Date.parse('2026-10-04T18:30:00.000Z'),
        });
    });

    it('does not strip a byline QUOTED inside the note body', () => {
        // The discriminating case for anchoring, and the only one that is: a body
        // line that contains the byline's exact wording mid-sentence. An unanchored
        // match would delete the agent's sentence and adopt the quoted date as the
        // note's own time.
        //
        // (An earlier version of this test used `_Left at the office_`, which passes
        // with or without anchoring because it never contains the byline's wording —
        // a test that named a failure it could not catch.)
        const quoted = 'I checked and it said _Left at 1999-01-01T00:00:00.000Z by the previous run of this agent._ which is wrong';
        const parsed = parseHandoff(
            renderHandoff({ agentName: 'kai', note: quoted, at: new Date('2026-10-04T18:30:00.000Z') }),
        );
        expect(parsed?.text).toBe(quoted);
        expect(parsed?.at).toBe(Date.parse('2026-10-04T18:30:00.000Z'));
    });
});

describe('a note a human edited', () => {
    it('still yields its text when the byline is gone, with no time', () => {
        // The writer's own doc calls this "plain markdown a human can read and
        // edit", so a note with the byline deleted is a supported shape, not
        // corruption.
        expect(parseHandoff('# Handoff — kai\n\nI rewrote this by hand.\n')).toEqual({
            text: 'I rewrote this by hand.',
            at: null,
        });
    });

    it('yields text from a note with no heading either', () => {
        expect(parseHandoff('just some prose')).toEqual({ text: 'just some prose', at: null });
    });

    it('reports an unparseable time as null rather than inventing one', () => {
        // Same rule as everywhere else in this model: null means "we do not know".
        // Falling back to the current time would date a month-old note to now and
        // sort it to the top of a transcript.
        const parsed = parseHandoff('# Handoff — kai\n\n_Left at not-a-date by the previous run of this agent._\n\nbody\n');
        expect(parsed).toEqual({ text: 'body', at: null });
    });
});

describe('nothing to show', () => {
    it('is null for an empty file', () => {
        expect(parseHandoff('')).toBeNull();
        expect(parseHandoff('   \n\n  ')).toBeNull();
    });

    it('is null when the note body is empty', () => {
        // `writeHandoff` refuses to write an empty note because "it looks like the
        // previous run had nothing to report", so a file that is only chrome means
        // the same thing on the way back in.
        expect(parseHandoff('# Handoff — kai\n\n_Left at 2026-10-04T18:30:00.000Z by the previous run of this agent._\n\n')).toBeNull();
    });

    it('is null for null input, so a missing file needs no special case at the call site', () => {
        expect(parseHandoff(null)).toBeNull();
    });
});
