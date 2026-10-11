/**
 * THE REPO REGISTRY (§6.1) — pure, over the envelope manifest's `repos[]`. Add registers a folder inside
 * the envelope under a slug derived from the name (unique); remove drops it; the HOST repo (`path: "."`,
 * the envelope itself) cannot be removed. Every refusal is a reason, never a thrown error, and the rest of
 * the manifest is carried through untouched — this module edits one key.
 */

export interface RepoEntry {
    readonly name: string;
    readonly slug: string;
    readonly path: string;
    /** `path: "."` — the envelope itself; protected. */
    readonly host: boolean;
}

export type RepoResult = { ok: true; manifest: Record<string, unknown>; slug: string } | { ok: false; reason: string };
export type RemoveResult = { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function rawRepos(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
    return Array.isArray(manifest.repos) ? manifest.repos.filter(isRecord) : [];
}

export function listRepos(manifest: Record<string, unknown>): RepoEntry[] {
    return rawRepos(manifest)
        .filter((r) => typeof r.name === 'string' && typeof r.slug === 'string' && typeof r.path === 'string')
        .map((r) => ({ name: r.name as string, slug: r.slug as string, path: r.path as string, host: r.path === '.' }));
}

export function slugOf(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Relative, forward-slashed, no leading `./`, no trailing `/`; `null` when it escapes the envelope. */
function envelopePath(path: string): string | null {
    const slashed = path.trim().replace(/\\/g, '/');
    if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return null;
    const parts: string[] = [];
    for (const seg of slashed.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (parts.length === 0) return null; parts.pop(); continue; }
        parts.push(seg);
    }
    return parts.length === 0 ? '.' : parts.join('/');
}

export function addRepo(manifest: Record<string, unknown>, input: { name: string; path: string; url?: string }): RepoResult {
    const name = input.name.trim();
    if (name.length === 0) return { ok: false, reason: 'a repo needs a name' };
    const path = envelopePath(input.path);
    if (path === null) return { ok: false, reason: `a repo must live inside the envelope; ${input.path} is outside it` };
    const slug = slugOf(name);
    if (slug.length === 0) return { ok: false, reason: `"${name}" gives no usable slug` };
    const existing = listRepos(manifest);
    const bySlug = existing.find((r) => r.slug === slug);
    if (bySlug) return { ok: false, reason: `a repo with slug "${slug}" is already registered` };
    const byPath = existing.find((r) => r.path === path);
    if (byPath) return { ok: false, reason: `${path} is already registered as "${byPath.slug}"` };
    const entry: Record<string, unknown> = { name, slug, path, ...(input.url ? { url: input.url } : {}) };
    return { ok: true, slug, manifest: { ...manifest, repos: [...rawRepos(manifest), entry] } };
}

export function removeRepo(manifest: Record<string, unknown>, slug: string): RemoveResult {
    const entry = listRepos(manifest).find((r) => r.slug === slug);
    if (!entry) return { ok: false, reason: `no repo with slug "${slug}"` };
    if (entry.host) return { ok: false, reason: `"${slug}" is the host repo (the envelope itself) and cannot be removed` };
    return { ok: true, manifest: { ...manifest, repos: rawRepos(manifest).filter((r) => r.slug !== slug) } };
}
