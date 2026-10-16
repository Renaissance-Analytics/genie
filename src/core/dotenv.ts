/**
 * A WORKSPACE'S SERVICE CONNECTION IN ITS APP'S `.env` (§6.6, hosting ship line H4) — the pure half.
 *
 * Genie hands every process and terminal it starts the workspace's service env, but an app reads its own `.env`:
 * a dev server started from an editor, an `artisan` run from a shell Genie did not open, a queue worker — all of
 * them read the file. Genie 1 learned this as genie#242 and wrote the connection into the `.env` of every repo the
 * workspace hosts a site from (env-sync.ts / env-store.ts); this is that, ported:
 *
 *   - **Which file:** `<repo>/.env` for each folder a site of the workspace serves from — the site is Genie being
 *     told "this checkout is an app I run". A workspace with no sites gets nothing written anywhere.
 *   - **Which keys:** the app's own config (`DB_*`, `DATABASE_URL`, `REDIS_*`, `MAIL_*`…), not the client-tool
 *     duplicates (`PG*`, `MYSQL_*`): nothing reads those from a `.env`, and a second copy of a credential no app
 *     reads is only a second place for it to leak from.
 *   - **How:** key by key. A key already in the file is rewritten IN PLACE (same line, same line ending); a new key
 *     joins one block under Genie's marker comment. Every other line — comments, blank lines, the person's own keys,
 *     the file's line endings — is carried through byte for byte. Nothing changed ⇒ the same text back (no write).
 *   - **Never into a file git would commit:** the caller asks git whether the `.env` is ignored and refuses
 *     otherwise (main/dotenv-sync.ts). Genie does not edit the person's `.gitignore` to make it so.
 */

/** The marker above the keys Genie added. Says who wrote them and that they are kept current, so nobody hand-edits a port back. */
export const MANAGED_ENV_HEADER = '# --- Genie: this workspace’s service connection, kept current by Genie ---';

/** `psql` reads `PG*`, `mysql` reads `MYSQL_*` — client tools, given to terminals; no app reads them from a `.env`. */
const CLIENT_TOOL_KEY = /^(PG[A-Z]+|MYSQL_)/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** The service env as it belongs in an app's `.env`: everything but the client-tool duplicates. */
export function dotEnvServiceVars(env: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (KEY.test(key) && !CLIENT_TOOL_KEY.test(key)) out[key] = value;
    return out;
}

function unquote(raw: string): string {
    const v = raw.trim();
    if (v.startsWith('"')) {
        const end = v.lastIndexOf('"');
        return (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/\\(["\\])/g, '$1');
    }
    if (v.startsWith("'")) {
        const end = v.lastIndexOf("'");
        return end > 0 ? v.slice(1, end) : v.slice(1);
    }
    // An unquoted value ends at an inline comment (` #…`), as dotenv parsers read it.
    const hash = v.search(/\s#/);
    return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** The file's assignments, last one winning (as dotenv reads it). Comments and blank lines are not values. */
export function parseDotEnv(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of text.split(/\r\n|\n|\r/)) {
        const m = ASSIGNMENT.exec(line);
        if (!m || line.trim().startsWith('#')) continue;
        out.set(m[1]!, unquote(line.slice(m[0].length)));
    }
    return out;
}

/** Raw when safe (`DB_PORT=4102`), double-quoted when the value would not read back as itself. */
function formatValue(value: string): string {
    if (value === '' || /[\s#"'=\\]/.test(value)) return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return value;
}

interface Line {
    text: string;
    /** The terminator this line actually had: `\r\n`, `\n`, `\r`, or `''` for a last line with none. */
    eol: string;
}

function splitLines(text: string): Line[] {
    const lines: Line[] = [];
    const re = /\r\n|\n|\r/g;
    let at = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        lines.push({ text: text.slice(at, m.index), eol: m[0] });
        at = m.index + m[0].length;
    }
    if (at < text.length) lines.push({ text: text.slice(at), eol: '' });
    return lines;
}

function dominantEol(text: string): string {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
}

/**
 * The file with `vars` set: each key that is already there rewritten on its own line (the LAST assignment, the one
 * dotenv reads), each new key added under {@link MANAGED_ENV_HEADER}. Keys whose value already agrees are not
 * touched; when none differs, the text comes back identical.
 */
export function upsertDotEnv(text: string, vars: Readonly<Record<string, string>>, header: string = MANAGED_ENV_HEADER): string {
    const current = parseDotEnv(text);
    const pending = Object.entries(vars).filter(([key, value]) => KEY.test(key) && current.get(key) !== value);
    if (pending.length === 0) return text;

    const eol = dominantEol(text);
    const lines = splitLines(text);
    const added: string[] = [];
    for (const [key, value] of pending) {
        let at = -1;
        lines.forEach((line, i) => { if (!line.text.trim().startsWith('#') && ASSIGNMENT.exec(line.text)?.[1] === key) at = i; });
        const assignment = `${key}=${formatValue(value)}`;
        if (at === -1) added.push(assignment);
        else lines[at] = { text: assignment, eol: lines[at]!.eol };
    }
    if (added.length > 0) {
        const headerAt = lines.findIndex((line) => line.text.trim() === header);
        if (headerAt !== -1) {
            // Grow Genie's block: after its last contiguous assignment.
            let end = headerAt + 1;
            while (end < lines.length && ASSIGNMENT.test(lines[end]!.text)) end += 1;
            if (end > 0 && lines[end - 1]!.eol === '') lines[end - 1]!.eol = eol;
            lines.splice(end, 0, ...added.map((a) => ({ text: a, eol })));
        } else {
            if (lines.length > 0 && lines[lines.length - 1]!.eol === '') lines[lines.length - 1]!.eol = eol;
            // Set apart from the person's content by one blank line; an empty file starts with the header.
            if (lines.length > 0 && lines[lines.length - 1]!.text.trim() !== '') lines.push({ text: '', eol });
            lines.push({ text: header, eol }, ...added.map((a) => ({ text: a, eol })));
        }
    }
    return lines.map((l) => l.text + l.eol).join('');
}

/** The folders whose `.env` a workspace's connection is written to: every folder one of its sites serves from, once each. */
export function dotEnvTargets(sites: readonly { readonly workspaceId: string; readonly repoPath: string }[], workspaceId: string): string[] {
    return [...new Set(sites.filter((s) => s.workspaceId === workspaceId && s.repoPath !== '').map((s) => s.repoPath))];
}
