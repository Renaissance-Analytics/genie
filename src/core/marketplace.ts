import type { PluginCapabilities, PluginManifest } from './plugins.js';

/** C2's anonymous REST contract. These values describe a package; they never authorize it. */
export interface MarketplaceVersion {
    readonly version: string;
    readonly digest: string;
    readonly key_id: string;
    readonly permissions: PluginCapabilities;
    readonly file_count: number;
    readonly uncompressed_size: number;
    readonly published_at: string;
    readonly download_url: string;
}
export interface MarketplacePackage {
    readonly id: string;
    readonly name: string;
    readonly publisher: {
        readonly id: string;
        readonly name: string;
        readonly verification: { readonly method: 'domain' | 'github_org'; readonly identity: string };
    };
    readonly version: MarketplaceVersion;
}
export interface MarketplaceRow extends MarketplacePackage {
    readonly installedVersion: string | null;
    readonly updateAvailable: boolean;
}
export interface MarketplaceReview {
    readonly token: string;
    readonly package: MarketplacePackage;
    readonly manifest: PluginManifest;
    readonly installedVersion: string | null;
    readonly needsConsent: boolean;
}
export interface MarketplaceApi {
    search(query: string, cursor?: string): Promise<{ packages: readonly MarketplaceRow[]; nextCursor: string | null }>;
    prepare(id: string, version: string): Promise<MarketplaceReview>;
    install(token: string, consent: boolean): Promise<{ id: string; version: string }>;
    discard(token: string): Promise<void>;
}

/** The bridge grants exact names. An empty extension list grants no files. */
export function needsMarketplaceConsent(previous: PluginCapabilities | null, next: PluginCapabilities): boolean {
    if (!previous) return true;
    const added = (before: readonly string[], after: readonly string[]): boolean => after.some(value => !before.includes(value));
    return added(previous.network.hosts, next.network.hosts)
        || added(previous.genieApi, next.genieApi)
        || (next.fs !== undefined && (previous.fs === undefined || previous.fs.scope !== next.fs.scope || added(previous.fs.extensions, next.fs.extensions)));
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function versionParts(value: string): { core: bigint[]; pre: string[] } {
    const match = value.length <= 200 ? SEMVER.exec(value) : null;
    const pre = match?.[4]?.split('.') ?? [];
    if (!match || pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) throw new Error('Invalid Marketplace version (expected SemVer)');
    return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre };
}
/** Exact SemVer precedence, including integers larger than Number can represent. Build metadata does not order releases. */
export function compareMarketplaceVersions(a: string, b: string): number {
    const left = versionParts(a), right = versionParts(b);
    const order = <T extends string | bigint>(x: T, y: T): number => x < y ? -1 : x > y ? 1 : 0;
    for (let i = 0; i < 3; i++) { const compared = order(left.core[i]!, right.core[i]!); if (compared) return compared; }
    if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
        const x = left.pre[i], y = right.pre[i];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
        const compared = xn && yn ? order(BigInt(x), BigInt(y)) : xn !== yn ? xn ? -1 : 1 : order(x, y);
        if (compared) return compared;
    }
    return 0;
}
