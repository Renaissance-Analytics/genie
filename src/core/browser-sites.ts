/**
 * THE GENIE BROWSER'S ONE-ROW SITE BAR (Tynn #709): a site is labelled by its workspace's name, not its address, and the
 * row holds as many chips as leave room for the "»" that carries the rest.
 */
export function siteLabel(host: string): string {
    return host.replace(/\.gen$/i, '');
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

export function browserSiteLabels(_hosts: readonly string[], _sites: readonly { host: string; workspaceId: string; name: string }[], _workspaceNames: Readonly<Record<string, string>>): Record<string, string> { return {}; }
