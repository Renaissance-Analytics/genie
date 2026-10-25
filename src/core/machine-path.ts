/**
 * THE MACHINE'S OWN PATH — the pure half (the owner's decision 3, 2026-10-18: the default applies to the whole machine,
 * "a one-time consented change"; plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3b). What goes on is the FIXED
 * `current` entries (core/toolchain-defaults.ts), so this is done once; choosing a default later only repoints a link.
 *
 * Both edits are reversible EXACTLY: Undo removes only what Genie added and restores the text it found, byte-for-byte.
 */

/** The marked block Genie adds to a shell startup file. The begin line also records whether Genie added a newline before it. */
export const SHELL_BEGIN = '# >>> genie toolchain defaults >>>';
const SHELL_BEGIN_JOINED = '# >>> genie toolchain defaults (+newline) >>>';
export const SHELL_END = '# <<< genie toolchain defaults <<<';

/** The startup files that make a login and an interactive shell see the entries: ~/.profile always, plus each that exists. */
const SHELL_CANDIDATES = ['.bash_profile', '.bashrc', '.zprofile', '.zshrc'] as const;

export function shellFilesToEdit(existing: readonly string[]): string[] {
    return ['.profile', ...SHELL_CANDIDATES.filter((f) => existing.includes(f))];
}

function shellBlock(entries: readonly string[], joined: boolean): string {
    return `${joined ? SHELL_BEGIN_JOINED : SHELL_BEGIN}\nexport PATH="${entries.join(':')}:$PATH"\n${SHELL_END}\n`;
}

/** The block's span in `text` (start..end, end including its trailing newline), or `null`. */
function blockSpan(text: string): { start: number; end: number; joined: boolean } | null {
    for (const [begin, joined] of [[SHELL_BEGIN, false], [SHELL_BEGIN_JOINED, true]] as const) {
        const start = text.indexOf(`${begin}\n`);
        if (start < 0) continue;
        const endAt = text.indexOf(`${SHELL_END}\n`, start);
        if (endAt < 0) continue;
        return { start, end: endAt + SHELL_END.length + 1, joined };
    }
    return null;
}

/** `text` with Genie's block for `entries`: replaced in place if there is one, else appended. Idempotent. */
export function applyShellBlock(text: string | null, entries: readonly string[]): string {
    const t = text ?? '';
    const span = blockSpan(t);
    if (span) return `${t.slice(0, span.start)}${shellBlock(entries, span.joined)}${t.slice(span.end)}`;
    const joined = t.length > 0 && !t.endsWith('\n');
    return `${t}${joined ? '\n' : ''}${shellBlock(entries, joined)}`;
}

/** `text` without Genie's block — exactly the text it was added to (a newline Genie added before it goes too). */
export function removeShellBlock(text: string): string {
    const span = blockSpan(text);
    if (!span) return text;
    const start = span.joined && span.start > 0 && text[span.start - 1] === '\n' ? span.start - 1 : span.start;
    return `${text.slice(0, start)}${text.slice(span.end)}`;
}

export function hasShellBlock(text: string | null): boolean {
    return text !== null && blockSpan(text) !== null;
}

const normWin = (p: string) => p.trim().replace(/[\\/]+$/, '').toLowerCase();

/** The RAW Windows user PATH with each missing entry first (in order); everything else kept byte-for-byte. Idempotent. */
export function windowsPathWith(raw: string, entries: readonly string[]): string {
    const have = new Set(raw.split(';').filter((e) => e.length > 0).map(normWin));
    const missing = entries.filter((e) => !have.has(normWin(e)));
    if (missing.length === 0) return raw;
    return raw.length > 0 ? `${missing.join(';')};${raw}` : missing.join(';');
}

/** The RAW Windows user PATH without Genie's entries (only those), everything else kept in order. */
export function windowsPathWithout(raw: string, entries: readonly string[]): string {
    const ours = new Set(entries.map(normWin));
    return raw.split(';').filter((e) => !(e.length > 0 && ours.has(normWin(e)))).join(';');
}

/** Whether every entry is on the RAW Windows user PATH. */
export function windowsPathHas(raw: string, entries: readonly string[]): boolean {
    const have = new Set(raw.split(';').map(normWin));
    return entries.every((e) => have.has(normWin(e)));
}
