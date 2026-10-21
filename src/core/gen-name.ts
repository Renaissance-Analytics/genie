/**
 * A SITE'S `.gen` NAME (§6.6) — the one rule, pure and dependency-free (the renderer reads it through browser-policy.ts,
 * so nothing here may import a Node module).
 *
 * A site's NAME is one or more DNS labels separated by dots: `tynn`, or Genie 1's default `<site>.<workspace>`
 * (`web.acme`; repos/genie main/dev-server/sites-config.ts `defaultGenNameFor`) — per-site subdomains, so every site is
 * its own origin. Its HOST is the name and `.gen`. Every label is checked on its own, and the refusal names the label
 * that is wrong. The Add and Edit forms, the agents' `sites` tool, the envelope reader, the site manager and the front
 * door all ask this module, so a name one of them accepts is a name every one of them serves.
 */

/** One DNS label: 1–63 of a-z, 0-9 and hyphens, never starting or ending with a hyphen. */
export const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** A whole DNS name is at most 253 characters — the `.gen` included. */
export const MAX_HOST = 253;

/**
 * A name as the person or agent typed it, the way Genie keeps it: trimmed, lower-cased, a trailing dot dropped, and a
 * trailing `.gen` (someone who types `web.acme.gen` means `web.acme`) taken off ONCE. Not validated.
 */
export function normalizeSiteName(name: string): string {
    const n = name.trim().toLowerCase().replace(/\.$/, '');
    return n.endsWith('.gen') ? n.slice(0, -'.gen'.length) : n;
}

/** Why these labels (already normalised — no `.gen`) cannot be a name, or `null`. */
function labelsProblem(n: string): string | null {
    if (n.length === 0) return 'a site needs a name';
    if (n.length + '.gen'.length > MAX_HOST) return `${n}.gen is longer than the ${MAX_HOST} characters a hostname may be`;
    const bad = n.split('.').find((label) => !DNS_LABEL.test(label));
    if (bad === undefined) return null;
    return bad === '' ? `"${n}" has an empty label (two dots together, or a dot at an end)` : `"${bad}" is not a hostname label (a-z, 0-9, hyphens inside, at most 63 characters)`;
}

/**
 * The names Genie serves itself, kept from sites — the name and everything under it (the owner, 2026-10-21: Mailpit's
 * `mail.gen` "one of the protected names so other workspace agents don't try using that for their sites").
 */
const KEPT_FOR_GENIE: Readonly<Record<string, string>> = {
    mail: 'its mail inbox (Mailpit)',
    websockets: 'its WebSockets server',
};

/** Why `name` cannot be a site's name, or `null` when it can. Kept names are refused for SITES only — still routable. */
export function siteNameProblem(name: string): string | null {
    const n = normalizeSiteName(name);
    const kept = Object.keys(KEPT_FOR_GENIE).find((k) => n === k || n.endsWith(`.${k}`));
    if (kept !== undefined) return `${n}.gen is kept for Genie — ${KEPT_FOR_GENIE[kept]} — so no site can have it; pick another name`;
    return labelsProblem(n);
}

/**
 * Is `host` (lower-case, no port) a `.gen` host a site can have — one or more valid labels, then `gen`? Read
 * strictly, with no normalising: `x.gen.gen` is not `x.gen`, and `gen` alone is no host.
 */
export function isGenHost(host: string): boolean {
    return host.endsWith('.gen') && labelsProblem(host.slice(0, -'.gen'.length)) === null;
}

/**
 * The site's `.gen` host: its name and `.gen`, lower-cased. `tynn` → `tynn.gen`, `web.acme` → `web.acme.gen`. Anything
 * else is refused with the label that is wrong.
 */
export function genHost(name: string): string {
    const problem = siteNameProblem(name);
    if (problem !== null) throw new Error(`${JSON.stringify(name)} is not a valid site name: ${problem}`);
    return `${normalizeSiteName(name)}.gen`;
}

/** Arbitrary text reduced to one DNS label, or `''` when nothing survives (Genie 1's `slugLabel`). */
export function slugLabel(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, 63)
        .replace(/-+$/, '');
}

/**
 * Genie 1's default name: `<site>.<workspace>`, from the site's folder and the workspace's name (Genie 1 used the
 * project's name). `folder: null` is a site at the workspace's own root — its folder IS the workspace — and is the
 * workspace's name alone (`acme`, never `acme.acme`). No usable workspace name → the folder's label alone.
 */
export function defaultSiteName(input: { folder: string | null; workspace: string | null }): string {
    const ws = input.workspace === null ? '' : slugLabel(input.workspace);
    if (input.folder === null) return ws || 'site';
    const site = slugLabel(input.folder) || 'site';
    return ws === '' ? site : `${site}.${ws}`;
}
