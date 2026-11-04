/** What an approval draws: all of its text. Long runs of blanks are counted and characters that cannot be seen are named. It changes only what is drawn. */
export interface ApprovalTextPart {
    readonly text: string;
    /** Genie's words for what is really there, drawn so they cannot be taken for the text. */
    readonly named: boolean;
}

/** Fewer than this is ordinary spacing, drawn as it is. */
const LONG_RUN = 4;
const inRanges = (ranges: ReadonlyArray<readonly [number, number]>) => (ch: string): boolean => { const code = ch.codePointAt(0) ?? 0; return ranges.some(([from, to]) => code >= from && code <= to); };
const isBlank = inRanges([[0x20, 0x20], [0x09, 0x09], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]);
const LINE_BREAK_RUN = 3;
/** Controls, zero-width characters and everything that changes direction. A tab and a line break have their own handling. */
const isUnseen = inRanges([[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]]);
const NAMES: Readonly<Record<string, string>> = { [String.fromCharCode(0x1b)]: 'ESC', [String.fromCharCode(0x0d)]: 'CR' };

const hex = (ch: string) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

export function visibleApprovalText(text: string): ApprovalTextPart[] {
    const parts: ApprovalTextPart[] = [];
    const say = (piece: string, named: boolean) => {
        const last = parts[parts.length - 1];
        if (last && last.named === named && !named) parts[parts.length - 1] = { text: last.text + piece, named };
        else parts.push({ text: piece, named });
    };
    const chars = [...text];
    for (let i = 0; i < chars.length;) {
        const ch = chars[i]!;
        // Line breaks, a CRLF counted as one.
        if (ch === '\n' || (ch === '\r' && chars[i + 1] === '\n')) {
            let count = 0;
            let at = i;
            while (at < chars.length && (chars[at] === '\n' || (chars[at] === '\r' && chars[at + 1] === '\n'))) { at += chars[at] === '\r' ? 2 : 1; count += 1; }
            if (count >= LINE_BREAK_RUN) { say(`[${count} line breaks]`, true); say('\n', false); } else { for (let n = 0; n < count; n += 1) say('⏎\n', false); }
            i = at;
            continue;
        }
        if (isBlank(ch)) {
            let at = i;
            while (at < chars.length && isBlank(chars[at]!)) at += 1;
            const run = chars.slice(i, at);
            const tabs = run.every((c) => c === '\t');
            if (run.length >= LONG_RUN) say(`[${run.length} ${tabs ? 'tabs' : 'spaces'}]`, true);
            else if (run.includes('\t')) { for (const c of run) { if (c === '\t') say('[TAB]', true); else say(c, false); } } else say(run.join(''), false);
            i = at;
            continue;
        }
        if (isUnseen(ch)) {
            say(`[${NAMES[ch] ?? hex(ch)}]`, true);
            i += 1;
            continue;
        }
        say(ch, false);
        i += 1;
    }
    return parts.length > 0 ? parts : [{ text: '', named: false }];
}
