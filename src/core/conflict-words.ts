import { computeDiff } from '@particle-academy/fancy-file-commons';

/**
 * THE CONFLICT BANNER'S WORDS (the board): `atlas changed lines 13–16 while you had unsaved edits to line 13`. Both
 * ranges come from the kit's diff engine — the disk's text and your buffer each against the text as it was OPENED —
 * never from a line count somebody guessed. Without an agent known to be writing the file, the author is not named:
 * `The file changed on disk at lines 13–16 …`. Genie does not guess the author.
 */
const lines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** The 1-based lines of `after` that differ from `before`; a pure removal is placed at the line it was removed before. */
export function changedLines(before: string, after: string): number[] {
    const out = new Set<number>();
    for (const hunk of computeDiff(lines(before), lines(after)).hunks) {
        let removedAt: number | null = null;
        let added = false;
        for (const line of hunk.lines) {
            if (line.side === 'after' && typeof line.afterLineNo === 'number') { out.add(line.afterLineNo); added = true; }
            else if (line.side === 'before' && typeof line.beforeLineNo === 'number' && removedAt === null) removedAt = line.beforeLineNo;
        }
        if (!added && removedAt !== null) out.add(removedAt);
    }
    return [...out].sort((a, b) => a - b);
}

/** `13–16`, `13`, `13–16 and 40` — contiguous runs joined with an en dash. */
export function rangesOf(numbers: readonly number[]): string {
    const runs: string[] = [];
    let start: number | null = null;
    let prev: number | null = null;
    const flush = () => { if (start !== null && prev !== null) runs.push(start === prev ? `${start}` : `${start}–${prev}`); };
    for (const n of numbers) {
        if (prev !== null && n === prev + 1) { prev = n; continue; }
        flush();
        start = n; prev = n;
    }
    flush();
    return runs.length <= 1 ? (runs[0] ?? '') : `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
}

const lineWord = (numbers: readonly number[]): string => `${numbers.length === 1 ? 'line' : 'lines'} ${rangesOf(numbers)}`;

export function conflictWords(baseline: string, mine: string, theirs: string, who: string | null): string {
    const theirLines = changedLines(baseline, theirs);
    const myLines = changedLines(baseline, mine);
    const theirPart = theirLines.length > 0 ? lineWord(theirLines) : 'the file';
    const myPart = myLines.length > 0 ? `unsaved edits to ${lineWord(myLines)}` : 'unsaved edits';
    return who
        ? `${who} changed ${theirPart} while you had ${myPart}`
        : `The file changed on disk at ${theirPart} while you had ${myPart}`;
}
