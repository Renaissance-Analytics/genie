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

/**
 * Upsert `KEY=value` into `.env` content, PRESERVING every other line + comment.
 * Replaces the key's existing line in place (the first match, honouring an
 * `export ` prefix); appends it (with a trailing newline) when absent.
 */
export function upsertEnvLine(content: string, key: string, value: string): string {
    const line = `${key}=${formatValue(value)}`;
    const lines = content.split(/\r?\n/);
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
            lines[i] = line;
            return lines.join('\n');
        }
    }
    // Append. Keep exactly one trailing newline after the new line.
    if (content === '') return line + '\n';
    const sep = content.endsWith('\n') ? '' : '\n';
    return content + sep + line + '\n';
}

/** True when `content` already assigns `key` (honouring an `export ` prefix). */
function keyLineIndex(lines: string[], key: string): number {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    return lines.findIndex((line) => re.test(line));
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
 */
export function upsertEnvBlock(
    content: string,
    vars: Record<string, string>,
    header: string,
): string {
    // Compare against the PARSED values, so a differently-quoted but equal value
    // counts as agreement and buys the no-op above.
    const current = parseEnv(content);
    const pending = Object.entries(vars).filter(([key, value]) => current.get(key) !== value);
    if (pending.length === 0) return content;

    const lines = content.split(/\r?\n/);
    const appended: string[] = [];
    for (const [key, value] of pending) {
        const at = keyLineIndex(lines, key);
        if (at === -1) appended.push(`${key}=${formatValue(value)}`);
        else lines[at] = `${key}=${formatValue(value)}`;
    }
    if (appended.length === 0) return lines.join('\n');

    const headerAt = lines.findIndex((line) => line.trim() === header);
    if (headerAt !== -1) {
        // Grow the existing block: insert after its last contiguous assignment.
        let end = headerAt + 1;
        while (end < lines.length && /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(lines[end])) {
            end += 1;
        }
        lines.splice(end, 0, ...appended);
        return lines.join('\n');
    }

    // No block yet — start one at the end, separated from the user's content by a
    // blank line (but not preceded by one in an empty file).
    const body = lines.join('\n');
    const lead = body === '' ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return `${body}${lead}${header}\n${appended.join('\n')}\n`;
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
