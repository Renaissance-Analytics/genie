/**
 * THE GENIE BROWSER'S ONE-ROW SITE BAR (Tynn #709): a site is labelled by its workspace's NAME, never its address — a
 * service host is named by the workspace's id (`<id>.mail.gen`), and an id is not something a person reads. The row holds
 * as many chips as leave room for the "»" that carries the rest.
 */
/** A ULID or any long machine label: 20+ letters and digits with a digit in them. */
export function isIdLike(label: string): boolean {
    return /^(?=.*\d)[0-9a-z]{20,}$/i.test(label);
}

/** The label a host gets with nothing known about it: its own name without `.gen`, and never a leading id. */
export function siteLabel(host: string): string {
    const parts = host.replace(/\.gen$/i, '').split('.');
    if (parts.length > 0 && isIdLike(parts[0] ?? '')) {
        const rest = parts.slice(1);
        return rest.length > 0 ? rest.join('.') : 'Workspace site';
    }
    return parts.join('.');
}

/** Each host's label, from the workspace names main knows: `<workspace>`, `<workspace> · <site>` where it has several. */
export function browserSiteLabels(hosts: readonly string[], sites: readonly { host: string; workspaceId: string; name: string }[], workspaceNames: Readonly<Record<string, string>>): Record<string, string> {
    const nameOf = (id: string): string | undefined => workspaceNames[id] ?? Object.entries(workspaceNames).find(([k]) => k.toLowerCase() === id.toLowerCase())?.[1];
    const byHost = new Map(sites.map((s) => [s.host.toLowerCase(), s]));
    const perWorkspace = new Map<string, number>();
    for (const s of sites) perWorkspace.set(s.workspaceId, (perWorkspace.get(s.workspaceId) ?? 0) + 1);
    const out: Record<string, string> = {};
    for (const host of hosts) {
        const h = host.toLowerCase();
        const site = byHost.get(h);
        const siteWorkspace = site ? nameOf(site.workspaceId) : undefined;
        if (site && siteWorkspace) {
            out[host] = (perWorkspace.get(site.workspaceId) ?? 0) > 1 ? `${siteWorkspace} · ${site.name}` : siteWorkspace;
            continue;
        }
        const parts = h.replace(/\.gen$/, '').split('.');
        const named = isIdLike(parts[0] ?? '') ? nameOf(parts[0] ?? '') : undefined;
        out[host] = named ? [named, ...parts.slice(1)].join(' · ') : siteLabel(host);
    }
    return out;
}

export function sitesThatFit(m: { widths: readonly number[]; available: number; moreWidth: number; gap: number }): number {
    const { widths, available, moreWidth, gap } = m;
    if (widths.length === 0 || available <= 0) return 0;
    const used = (n: number) => widths.slice(0, n).reduce((a, b) => a + b, 0) + Math.max(0, n - 1) * gap;
    if (used(widths.length) <= available) return widths.length;
    for (let n = widths.length - 1; n >= 1; n--) {
        if (used(n) + gap + moreWidth <= available) return n;
    }
    return 0;
}
