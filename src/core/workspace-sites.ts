/** Inert stub (RED): sites saved portably (Tynn #756, PR4). The implementation lands after the tests are seen failing. */

export interface SiteRewrite {
    readonly path: string;
    readonly from: string;
    readonly to: string;
}

export function portableSites(manifest: Record<string, unknown>, _workspacePath: string): { manifest: Record<string, unknown>; rewrites: SiteRewrite[]; notes: string[] } {
    return { manifest, rewrites: [], notes: [] };
}
