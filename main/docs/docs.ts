import fs from 'node:fs';
import path from 'node:path';

/**
 * Core (Electron-free) logic for the in-app Docs viewer.
 *
 * The user guide ships as numeric-prefixed markdown files in the repo's
 * `docs/` folder (e.g. `00-overview.md`, `01-getting-started.md`). The viewer
 * lists them in filename order and renders each on demand. Everything here is
 * a pure function over a docs directory + a slug so it can be unit-tested
 * without an Electron runtime; the IPC wiring (ipc.ts) only resolves the dir
 * and forwards the calls.
 *
 * Slugs are the filename WITHOUT the `.md` extension (e.g. `00-overview`). Only
 * files matching `NN-name.md` are surfaced, which deliberately excludes the
 * repo's developer docs (agi-format.md, release-pipeline.md) — they have no
 * numeric prefix — from the user-facing viewer.
 */

/** A `NN-some-slug` filename (digits, then a `-name` body). No path, no `.md`. */
const SLUG_RE = /^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface DocEntry {
    slug: string;
    title: string;
}

/**
 * Pull a human title from markdown: the first `# H1` line if present,
 * otherwise a Title-Cased version of the slug body (minus its numeric prefix).
 */
export function extractTitle(markdown: string, slug: string): string {
    for (const raw of markdown.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) return m[1].trim();
        // Stop scanning at the first non-blank, non-H1 line — the title, if
        // any, is at the very top.
        break;
    }
    return titleFromSlug(slug);
}

function titleFromSlug(slug: string): string {
    const body = slug.replace(/^\d+-/, '');
    return body
        .split('-')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Is `slug` a safe docs slug? Must match the `NN-name` shape — which by
 * construction contains no path separators, `.`, or `..` — so it cannot be
 * used to traverse out of the docs dir. Returns the same boolean the IPC
 * read-guard relies on.
 */
export function isSafeSlug(slug: unknown): slug is string {
    return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * List the user-guide docs in `docsDir`, ordered by filename (which the `NN-`
 * prefix makes a deliberate reading order). Returns `[]` if the dir is missing
 * or unreadable. Each entry's title is read from its first H1.
 */
export function listDocs(docsDir: string): DocEntry[] {
    let names: string[];
    try {
        names = fs.readdirSync(docsDir);
    } catch {
        return [];
    }
    const slugs = names
        .filter((n) => n.toLowerCase().endsWith('.md'))
        .map((n) => n.slice(0, -'.md'.length))
        .filter(isSafeSlug)
        .sort((a, b) => a.localeCompare(b, 'en'));

    const out: DocEntry[] = [];
    for (const slug of slugs) {
        let md = '';
        try {
            md = fs.readFileSync(path.join(docsDir, `${slug}.md`), 'utf8');
        } catch {
            continue;
        }
        out.push({ slug, title: extractTitle(md, slug) });
    }
    return out;
}

/**
 * Read one doc's markdown. Rejects an unsafe slug (path traversal / wrong
 * shape) by returning `null`, and returns `null` for a missing file — the
 * renderer treats `null` as "not found". Only files directly inside `docsDir`
 * are ever read.
 */
export function readDoc(docsDir: string, slug: unknown): string | null {
    if (!isSafeSlug(slug)) return null;
    const file = path.join(docsDir, `${slug}.md`);
    // Defence in depth: even though the slug shape forbids separators, confirm
    // the resolved path is still directly inside docsDir.
    const root = path.resolve(docsDir);
    const abs = path.resolve(file);
    if (path.dirname(abs) !== root) return null;
    try {
        return fs.readFileSync(abs, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Defensively resolve the bundled `docs/` directory across dev and packaged
 * (asar) builds. Mirrors how the tray icons are resolved in background.ts but
 * tries multiple candidates (like the pty-host resolver does) and returns the
 * first that exists, so it survives differences in where the main bundle ends
 * up. Returns the first existing candidate, or the best-guess first candidate
 * if none exist (so callers still get a sane, if empty, dir).
 *
 * @param dirname      `__dirname` of the compiled main bundle (`<root>/app`).
 * @param cwd          `process.cwd()` (repo root in dev).
 * @param resourcesPath `process.resourcesPath` (packaged: the app's resources).
 */
export function resolveDocsDir(
    dirname: string,
    cwd: string,
    resourcesPath?: string,
): string {
    const candidates = [
        // Dev: repo root /docs (NODE_ENV !== production runs from the checkout).
        path.join(cwd, 'docs'),
        // Packaged: electron-builder's `files` filter ships docs/** at the asar
        // root, a sibling of the `app/` main bundle — i.e. <asar>/docs.
        path.join(dirname, '..', 'docs'),
        // Same idea but one level deeper, in case the bundle nests differently.
        path.join(dirname, '..', '..', 'docs'),
        // Belt-and-braces: alongside the resources dir if a build ever ships
        // docs there instead of the asar root.
        ...(resourcesPath ? [path.join(resourcesPath, 'docs')] : []),
        // Last resort: relative to the bundle itself.
        path.join(dirname, 'docs'),
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
        } catch {
            /* try next */
        }
    }
    return candidates[0];
}
