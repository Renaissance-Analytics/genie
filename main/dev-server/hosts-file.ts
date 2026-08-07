/**
 * The OS hosts-file manager for host-native `.gen` sites.
 *
 * Host-native site hosting (Wish #102, story #238) runs a site as a HOST process
 * and serves it at `https://<name>.gen` through a host reverse proxy. For that
 * name to resolve in the machine's OWN browser (Chrome/Edge), `<name>.gen` must
 * point at loopback in the OS hosts file — the in-app Testing Browser's proxy
 * shim is not available to a real browser.
 *
 * Hosts files cannot wildcard, so we cannot write a single `*.gen` line: the
 * manager writes one concrete `127.0.0.1 <name>.gen` (+ the `::1` IPv6 loopback)
 * per live site, all inside a delimited MANAGED BLOCK. The block lets us rewrite
 * and remove Genie's entries cleanly on every reconcile while NEVER touching the
 * user's own lines — the cardinal rule for a file this destructive to corrupt.
 *
 * Everything here is PURE (string in ⇒ string out), so the block math is
 * deterministically testable. The privileged write to the real hosts file needs
 * elevation (Administrator on Windows, root elsewhere) and is validated on a real
 * machine; {@link reconcileHostsFile} isolates that IO behind an injected pair so
 * the "skip the write (and the elevation prompt) when nothing changed" logic is
 * testable without touching the OS.
 */

export const HOSTS_BLOCK_BEGIN = '# BEGIN GENIE SITES';
export const HOSTS_BLOCK_END = '# END GENIE SITES';

/** A `.gen` hostname safe to write verbatim into a hosts file: DNS labels only,
 *  no whitespace/newlines (which would let a name inject extra host lines), and
 *  it MUST be a `.gen` name — we only ever manage our own sites. */
const GEN_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.gen$/;

function assertGenName(name: string): void {
    if (typeof name !== 'string' || !GEN_HOST_RE.test(name)) {
        throw new Error(`hosts-file: refusing invalid .gen name ${JSON.stringify(name)}`);
    }
}

/** Normalise a name list to the sorted, de-duplicated set actually written —
 *  the canonical form every function agrees on. Throws on an injectable name. */
function normaliseNames(genNames: string[]): string[] {
    for (const n of genNames) assertGenName(n);
    return [...new Set(genNames)].sort((a, b) => a.localeCompare(b));
}

/** The managed block's lines (BEGIN, per-name loopback pairs, END) — the shared
 *  core so {@link renderGenHostsBlock} and {@link upsertGenHostsBlock} stay in
 *  lockstep regardless of the line ending each joins with. */
function genBlockLines(genNames: string[]): string[] {
    const names = normaliseNames(genNames);
    const lines = [HOSTS_BLOCK_BEGIN];
    for (const name of names) {
        lines.push(`127.0.0.1\t${name}`);
        lines.push(`::1\t${name}`);
    }
    lines.push(HOSTS_BLOCK_END);
    return lines;
}

/** Render the managed block as a standalone string (LF-joined, no trailing
 *  newline). For inspection/round-trip; {@link upsertGenHostsBlock} is what
 *  actually splices it into a hosts file with that file's own line ending. */
export function renderGenHostsBlock(genNames: string[]): string {
    return genBlockLines(genNames).join('\n');
}

/** The sorted-unique `.gen` names currently inside the managed block, or `[]`
 *  when there is no block. Reads both loopback families but returns each name
 *  once. */
export function parseGenHostsBlock(content: string): string[] {
    const lines = content.split(/\r?\n/);
    const begin = lines.findIndex((l) => l.trim() === HOSTS_BLOCK_BEGIN);
    if (begin < 0) return [];
    const names = new Set<string>();
    for (let i = begin + 1; i < lines.length; i++) {
        if (lines[i].trim() === HOSTS_BLOCK_END) break;
        const m = lines[i].match(/^\s*(?:127\.0\.0\.1|::1)\s+(\S+)\s*$/);
        if (m) names.add(m[1]);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Return `content` with Genie's managed block set to exactly `genNames`:
 * replaced in place if a block already exists, appended if not, and removed
 * entirely when `genNames` is empty. Every non-managed line — the user's own
 * entries — is preserved verbatim, as is the file's line ending and trailing
 * newline, so an append followed by a removal restores the original byte-for-byte.
 *
 * A truncated block (a BEGIN marker with no END, e.g. an interrupted earlier
 * write) is treated as running to end-of-file and rewritten, so a crash mid-write
 * self-heals instead of leaving the file corrupt.
 */
export function upsertGenHostsBlock(content: string, genNames: string[]): string {
    const names = normaliseNames(genNames);
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailing = content.endsWith(eol);
    const body = hadTrailing ? content.slice(0, -eol.length) : content;
    const lines = body === '' ? [] : body.split(eol);

    const begin = lines.findIndex((l) => l.trim() === HOSTS_BLOCK_BEGIN);
    let head = lines;
    let tail: string[] = [];
    if (begin >= 0) {
        const endRel = lines.slice(begin + 1).findIndex((l) => l.trim() === HOSTS_BLOCK_END);
        // No END ⇒ truncated block: everything from BEGIN onward is ours to redo.
        const end = endRel < 0 ? lines.length - 1 : begin + 1 + endRel;
        head = lines.slice(0, begin);
        tail = lines.slice(end + 1);
    }

    const block = names.length > 0 ? genBlockLines(names) : [];
    const next = [...head, ...block, ...tail];
    if (next.length === 0) return hadTrailing ? '' : '';
    return next.join(eol) + (hadTrailing ? eol : '');
}

/** Whether writing `genNames` would change `content` — used to skip the write,
 *  and thus the elevation prompt, when the hosts file is already in sync. */
export function hostsBlockNeedsUpdate(content: string, genNames: string[]): boolean {
    return upsertGenHostsBlock(content, genNames) !== content;
}

/** Read + compute + (only if changed) write the hosts file. The `io` pair is
 *  injected so callers supply the real elevated reader/writer while tests supply
 *  fakes — the point being to PROVE we never write (never prompt for elevation)
 *  when nothing changed. */
export async function reconcileHostsFile(
    genNames: string[],
    io: { read: () => Promise<string>; write: (next: string) => Promise<void> },
): Promise<{ changed: boolean }> {
    const current = await io.read();
    const next = upsertGenHostsBlock(current, genNames);
    if (next === current) return { changed: false };
    await io.write(next);
    return { changed: true };
}
