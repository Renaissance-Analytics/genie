/**
 * Pure `.env` helpers — parsing, key-preserving upsert, and secret
 * detection/obfuscation. No fs / electron, so they unit-test directly. The
 * file-touching operations (resolve target, read/write, gitignore) live in
 * `env-store.ts`; the MCP `setEnv`/`checkEnv` tools sit on top of both.
 */

/** A valid env key: starts with a letter or `_`, then letters/digits/`_`. */
export function isValidEnvKey(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Strip one layer of matching surrounding quotes from a raw value. */
function unquote(raw: string): string {
    const v = raw.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
        return v.slice(1, -1);
    }
    // Unquoted: a ` #...` starts an inline comment.
    const hash = v.search(/\s#/);
    return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/**
 * Parse `.env` content into key→value. Skips blanks + `#` comments, tolerates a
 * leading `export `, splits on the FIRST `=`, and unquotes the value. Later
 * duplicate keys win (matching how a shell would source it).
 */
export function parseEnv(content: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const body = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
        const eq = body.indexOf('=');
        if (eq <= 0) continue;
        const key = body.slice(0, eq).trim();
        if (!isValidEnvKey(key)) continue;
        out.set(key, unquote(body.slice(eq + 1)));
    }
    return out;
}

/** Quote a value for writing only when it needs it (whitespace / `#` / quotes /
 *  empty); otherwise write it raw so `TOKEN=rpk_…` stays clean. */
function formatValue(value: string): string {
    if (value === '' || /[\s#"'=]/.test(value)) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}

// --- byte-preserving line model ---------------------------------------------

/**
 * One physical line and THE TERMINATOR IT ACTUALLY HAD.
 *
 * The writer used to `split(/\r?\n/)` and `join('\n')`, which silently converted
 * the entire file to LF the moment any single value changed. On Windows that is
 * every line of somebody's `.env` turning up as a diff because a port moved. So
 * each line carries its own ending, untouched lines are re-emitted byte for byte,
 * and only the lines Genie rewrites are Genie's to shape.
 */
interface EnvLine {
    text: string;
    /** `\r\n`, `\n`, `\r`, or `''` for a final line with no terminator. */
    eol: string;
}

function splitLines(content: string): EnvLine[] {
    const out: EnvLine[] = [];
    const re = /\r\n|\n|\r/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        out.push({ text: content.slice(last, m.index), eol: m[0] });
        last = re.lastIndex;
    }
    if (last < content.length) out.push({ text: content.slice(last), eol: '' });
    return out;
}

/** Exactly inverse to {@link splitLines}: `joinLines(splitLines(x)) === x`. */
function joinLines(lines: readonly EnvLine[]): string {
    let out = '';
    for (const line of lines) out += line.text + line.eol;
    return out;
}

/** The ending NEW lines should use: whatever the file already mostly uses. A file
 *  with no newline at all (or a brand-new one) gets LF. */
function dominantEol(content: string): string {
    const crlf = (content.match(/\r\n/g) ?? []).length;
    const lf = (content.match(/\n/g) ?? []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
}

/**
 * Where `key` is assigned, or `-1`.
 *
 * The LAST assignment, not the first — because that is the one that takes effect.
 * `parseEnv`, every dotenv implementation and a shell all let a later duplicate
 * win, so rewriting the first copy in a hand-edited file with two of them leaves
 * the application reading the stale second one. That is the exact
 * `.env`-says-51157-but-the-port-is-58377 failure this whole feature exists to
 * end, and the writer was capable of causing it itself.
 *
 * Refuses a key that is not a legal env name: it goes into a RegExp, and `DB.*`
 * matched — and overwrote — the unrelated line `DB_PORT=51157`.
 */
function keyLineIndex(lines: readonly EnvLine[], key: string): number {
    if (!isValidEnvKey(key)) return -1;
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (re.test(lines[i].text)) return i;
    }
    return -1;
}

/** Append `add` to `lines`, terminating a final line that had no ending. */
function appendLines(lines: EnvLine[], add: readonly string[], eol: string): void {
    if (add.length === 0) return;
    const last = lines[lines.length - 1];
    if (last && last.eol === '') last.eol = eol;
    for (const text of add) lines.push({ text, eol });
}

/**
 * Upsert `KEY=value` into `.env` content, PRESERVING every other line + comment.
 * Replaces the key's EFFECTIVE assignment in place (the last one, honouring an
 * `export ` prefix); appends it when absent. Untouched lines keep their exact
 * bytes, including their line endings.
 */
export function upsertEnvLine(content: string, key: string, value: string): string {
    if (!isValidEnvKey(key)) return content;
    const line = `${key}=${formatValue(value)}`;
    const lines = splitLines(content);
    const at = keyLineIndex(lines, key);
    if (at !== -1) {
        lines[at] = { text: line, eol: lines[at].eol };
        return joinLines(lines);
    }
    // Append. Keep exactly one trailing newline after the new line.
    if (content === '') return line + '\n';
    appendLines(lines, [line], dominantEol(content));
    return joinLines(lines);
}

/**
 * Upsert a WHOLE SET of managed keys into `.env` content (genie#242).
 *
 * The file belongs to the USER — hand-edited, commented, ordered how they left
 * it — and Genie now rewrites it whenever a service port moves. So three
 * properties are load-bearing, and each has a test:
 *
 *  - **Read-modify-write, never regenerate.** Every other key, comment, blank
 *    line and trailing byte survives. A key Genie manages is rewritten where it
 *    ALREADY IS, wherever the user moved it to — so a second copy can never
 *    appear and shadow the one they are reading.
 *  - **New keys land in one marked block.** Appended under `header`, and a later
 *    addition joins that block instead of writing a second header, so the
 *    managed region stays one contiguous, recognisable thing.
 *  - **Byte-identical when nothing moved.** The content is returned UNCHANGED —
 *    the same string — when every managed value already agrees. Not "equivalent":
 *    rewriting a CRLF file to LF, or requoting a value, is a diff the user did
 *    not ask for, and a `.env` that churns on every service tick is one nobody
 *    will trust to hold their own edits.
 *
 * Two more, learned from the files people actually have rather than the tidy one:
 *
 *  - **A line Genie does not rewrite keeps its exact bytes, ENDING INCLUDED.** The
 *    first version split on `/\r?\n/` and joined with `\n`, so the moment one value
 *    changed the whole file was converted to LF — every line of somebody's `.env`
 *    turning up as a diff because a port moved.
 *  - **The assignment that WINS is the one rewritten.** In a hand-edited file with
 *    the key twice, dotenv reads the last; rewriting the first left the app on the
 *    stale value — this feature's own bug, reintroduced by its fix. Nothing is
 *    deleted to achieve that: the user's earlier line is theirs.
 */
export function upsertEnvBlock(
    content: string,
    vars: Record<string, string>,
    header: string,
): string {
    // Compare against the PARSED values, so a differently-quoted but equal value
    // counts as agreement and buys the no-op above. An illegal key is dropped
    // here rather than turned into a RegExp that could match somebody else's line.
    const current = parseEnv(content);
    const pending = Object.entries(vars).filter(
        ([key, value]) => isValidEnvKey(key) && current.get(key) !== value,
    );
    if (pending.length === 0) return content;

    const eol = dominantEol(content);
    const lines = splitLines(content);
    const appended: string[] = [];
    for (const [key, value] of pending) {
        const at = keyLineIndex(lines, key);
        const text = `${key}=${formatValue(value)}`;
        if (at === -1) appended.push(text);
        else lines[at] = { text, eol: lines[at].eol };
    }
    if (appended.length === 0) return joinLines(lines);

    const headerAt = lines.findIndex((line) => line.text.trim() === header);
    if (headerAt !== -1) {
        // Grow the existing block: insert after its last contiguous assignment.
        let end = headerAt + 1;
        while (
            end < lines.length &&
            /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(lines[end].text)
        ) {
            end += 1;
        }
        if (end === lines.length) appendLines(lines, appended, eol);
        else lines.splice(end, 0, ...appended.map((text) => ({ text, eol })));
        return joinLines(lines);
    }

    // No block yet — start one at the end, separated from the user's content by a
    // blank line (but not preceded by one in an empty file).
    if (content === '') return `${header}${eol}${appended.join(eol)}${eol}`;
    appendLines(lines, ['', header, ...appended], eol);
    if (lines[lines.length - 1].eol === '') lines[lines.length - 1].eol = eol;
    return joinLines(lines);
}

// --- secret detection + obfuscation -----------------------------------------

/** Key-name patterns that mark a value as a secret (case-insensitive). Broad on
 *  purpose — obfuscation is the safe default; the agent can pass `force`. */
const SECRET_KEY_RE =
    /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PASS|PWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/;

/** True when the KEY name looks like a secret (e.g. `*TOKEN`, `*SECRET`,
 *  `*PASSWORD`, `*PASS`, `*PWD`, `*API_KEY`, or ends with `KEY`). */
export function isSecretKey(key: string): boolean {
    const u = key.toUpperCase();
    return SECRET_KEY_RE.test(u) || /(^|_)KEY$/.test(u);
}

/** True when the VALUE itself looks like a secret (known token prefixes, a JWT,
 *  or a long high-entropy token) — catches secrets in innocuously-named keys. */
export function isSecretValue(value: string): boolean {
    const v = value.trim();
    if (!v) return false;
    if (
        /^(rpk_|sk-|sk_|pk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|glpat-)/.test(
            v,
        )
    ) {
        return true;
    }
    // JWT: three base64url segments.
    if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) return true;
    // Long, unbroken, base64/hex-ish token.
    if (v.length >= 32 && !/\s/.test(v) && /^[A-Za-z0-9+/=_.-]+$/.test(v)) return true;
    return false;
}

/** A value is treated as a secret if EITHER its key OR its shape says so. */
export function isSecret(key: string, value: string): boolean {
    return isSecretKey(key) || isSecretValue(value);
}

/**
 * Obfuscate a secret to the LAST 4 characters behind a fixed dotted prefix
 * (e.g. `••••••3f2a`) — what `checkEnv` returns for a detected secret unless
 * `force` is set.
 */
export function obfuscateSecret(value: string): string {
    return '••••••' + value.slice(-4);
}
