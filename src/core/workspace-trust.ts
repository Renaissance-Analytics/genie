/**
 * WHAT A WORKSPACE WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT. Red: the shape only.
 */
export interface TrustList {
    readonly sites: readonly { readonly key: string; readonly fingerprint: string; readonly runs: string; readonly folder: string; readonly npmScript: string | null }[];
    readonly hooks: readonly { readonly file: string; readonly event: string; readonly command: string }[];
    readonly servers: readonly { readonly file: string; readonly name: string; readonly command: string }[];
    readonly gitKeys: readonly GitConfigEntry[];
}
export interface GitConfigEntry { readonly key: string; readonly value: string }
export interface TrustRecord { readonly carried: readonly string[]; readonly workspaces: Readonly<Record<string, string>> }

export function parseGitConfigList(_text: string): GitConfigEntry[] { return []; }
export function unsafeGitKeys(_entries: readonly GitConfigEntry[]): GitConfigEntry[] { return []; }
export function npmRunTarget(_command: string): string | null { return null; }
export function trustHash(_list: TrustList): string { return ''; }
export function trustVerdict(_record: TrustRecord, _workspaceId: string, _hash: string): { trusted: boolean; changed: boolean } { return { trusted: true, changed: false }; }
