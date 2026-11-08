import { describe, expect, it } from 'vitest';
import { outputStep } from '../src/core/terminal-output-stream.js';
import { emptyWorkspace, OUTPUT_CAP, terminalClosed, terminalData, terminalOpened, terminalOutput, terminalReplaced, terminalSuspended } from '../src/core/workspace-view.js';

/*
 * A TERMINAL PAST ITS OUTPUT CAP (Tynn #542). The view keeps a terminal's newest OUTPUT_CAP characters, trimmed from the
 * front. fancy-term's controlled `output` diffs the new string against the one it wrote: a trimmed string is not an
 * extension of it, so past the cap every batch (each ~33 ms) reset the terminal and wrote all 2 MB again. Now the pane is
 * told how far the stream has come, and writes what was appended: never a reset while the same stream goes on.
 */

const tab = { id: 't1', workspaceId: 'w', shell: 'bash', pid: 1, exited: null };

describe('outputStep: what the pane writes, from the stream position', () => {
    it('fills once, writes only what was appended, and resets only for a new stream or more than it keeps', () => {
        expect(outputStep(null, { text: 'abc', end: 3, epoch: 1 })).toEqual({ reset: false, write: 'abc' });
        expect(outputStep({ text: 'abc', end: 3, epoch: 1 }, { text: 'abc', end: 3, epoch: 1 })).toBeNull();
        expect(outputStep({ text: 'abc', end: 3, epoch: 1 }, { text: 'abcde', end: 5, epoch: 1 })).toEqual({ reset: false, write: 'de' });
        // PAST THE CAP: the front was trimmed, so the new text is no extension of the old; two were appended, two are written.
        expect(outputStep({ text: 'abcd', end: 10, epoch: 1 }, { text: 'cdef', end: 12, epoch: 1 })).toEqual({ reset: false, write: 'ef' });
        // A new stream (a snapshot replaced the output): all of it, from a clean terminal.
        expect(outputStep({ text: 'abcd', end: 10, epoch: 1 }, { text: 'xy', end: 2, epoch: 2 })).toEqual({ reset: true, write: 'xy' });
        // More arrived between two renders than the view keeps: the kept text, from a clean terminal.
        expect(outputStep({ text: 'abcd', end: 10, epoch: 1 }, { text: 'wxyz', end: 20, epoch: 1 })).toEqual({ reset: true, write: 'wxyz' });
        // Without a position (an agent's own terminal), as before: an extension writes its tail, anything else resets.
        expect(outputStep({ text: 'ab' }, { text: 'abc' })).toEqual({ reset: false, write: 'c' });
        expect(outputStep({ text: 'ab' }, { text: 'xb' })).toEqual({ reset: true, write: 'xb' });
    });
});

describe('the stream position in the workspace view', () => {
    it('counts every character appended, the trimmed ones too; a replacement starts a new stream; a close forgets it', () => {
        let s = terminalOpened(emptyWorkspace(), tab, 'hello');
        expect(terminalOutput(s, 't1')).toEqual({ text: 'hello', end: 5, epoch: 1 });
        s = terminalData(s, 't1', ' world');
        expect(terminalOutput(s, 't1')).toEqual({ text: 'hello world', end: 11, epoch: 1 });
        // Held back while suspended: nothing reached the view, so the stream did not move.
        s = terminalSuspended(s, 't1', true);
        s = terminalData(s, 't1', 'held');
        expect(terminalOutput(s, 't1').end).toBe(11);
        s = terminalSuspended(s, 't1', false);
        s = terminalReplaced(s, 't1', 'snap');
        expect(terminalOutput(s, 't1')).toEqual({ text: 'snap', end: 4, epoch: 2 });
        s = terminalClosed(s, 't1');
        expect(terminalOutput(s, 't1')).toEqual({ text: '', end: 0, epoch: 0 });
    });

    it('streams past the cap with no reset and exactly what arrived written, batch after batch', () => {
        let s = terminalOpened(emptyWorkspace(), tab, '');
        s = terminalData(s, 't1', 'a'.repeat(OUTPUT_CAP - 10));
        let shown = terminalOutput(s, 't1');
        const written: string[] = [];
        for (let i = 0; i < 5; i += 1) {
            const batch = `line ${i}\n`;
            s = terminalData(s, 't1', batch);
            const next = terminalOutput(s, 't1');
            const step = outputStep(shown, next);
            expect(step?.reset).toBe(false);
            written.push(step!.write);
            shown = next;
        }
        expect(terminalOutput(s, 't1').text).toHaveLength(OUTPUT_CAP);
        expect(written).toEqual(['line 0\n', 'line 1\n', 'line 2\n', 'line 3\n', 'line 4\n']);
    });
});
