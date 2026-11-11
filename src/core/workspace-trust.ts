import { createHash } from 'node:crypto';

/**
 * WHAT A WORKSPACE WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT. One record on this machine and one verdict. The yes is kept until the person takes it back; the list is what they are shown when they give it. The pure half.
 *
 * The hash covers what the list shows: each site's run fingerprint and the npm script its command names, the hooks and servers a workspace's own files declare, and the git keys that could run something, with their values.
 * It does not cover the code those run, or the instructions an agent reads.
 *
 * Git keys are checked against a list of the safe ones, not a list of the dangerous ones: a key nobody has listed is not assumed safe. Reading them with `git config --list` runs nothing (measured on Linux and Windows).
 */
export interface TrustSite { readonly key: string; readonly fingerprint: string; readonly runs: string; readonly folder: string; readonly npmScript: string | null }
export interface TrustHook { readonly file: string; readonly event: string; readonly command: string }
export interface TrustServer { readonly file: string; readonly name: string; readonly command: string }
export interface GitConfigEntry { readonly key: string; readonly value: string }

export interface TrustList {
    readonly sites: readonly TrustSite[];
    readonly hooks: readonly TrustHook[];
    readonly servers: readonly TrustServer[];
    readonly gitKeys: readonly GitConfigEntry[];
    /** Commands a person approved one at a time in an untracked settings.local.json: shown on the list, and not hashed, or each approval would ask again. */
    readonly approvals: readonly string[];
}

export interface TrustRecord { readonly carried: readonly string[]; readonly workspaces: Readonly<Record<string, string>> }

/** `git config --list -z`: each entry is a key, a line break and its value, and a key with no value has no line break. Keys come lower-cased where git keeps them so, and are lower-cased here for the rest. */
export function parseGitConfigList(text: string): GitConfigEntry[] {
    return text.split(String.fromCharCode(0)).filter((entry) => entry.length > 0).map((entry) => {
        const at = entry.indexOf(String.fromCharCode(10));
        return at < 0 ? { key: entry.toLowerCase(), value: '' } : { key: entry.slice(0, at).toLowerCase(), value: entry.slice(at + 1) };
    });
}

const SAFE_GIT_KEYS: readonly RegExp[] = [
    /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|longpaths|quotepath|sharedrepository)$/,
    /^remote\.[^.]+(\..+)?\.(url|pushurl|fetch|push|prune|tagopt|mirror)$/,
    /^branch\..+\.(remote|merge|rebase|pushremote|description)$/,
    /^user\.(name|email)$/,
    /^submodule\..+\.(url|active|branch)$/,
    /^(pull\.(rebase|ff)|push\.default|fetch\.prune|init\.defaultbranch|extensions\.(objectformat|worktreeconfig)|lfs\.repositoryformatversion)$/,
];

/** The entries that could run something, or that this can't vouch for. */
export function unsafeGitKeys(entries: readonly GitConfigEntry[]): GitConfigEntry[] {
    return entries.filter(({ key, value }) => {
        if (!SAFE_GIT_KEYS.some((safe) => safe.test(key))) return true;
        return /\.(url|pushurl)$/.test(key) && /^ext::/i.test(value.trim());
    });
}

/** The script `npm run <x>` names, or `null`. Only this exact form: npm scripts are all the trust step can speak for. */
export function npmRunTarget(command: string): string | null {
    return /^npm\s+run(?:-script)?\s+([^\s-]\S*)/.exec(command.trim())?.[1] ?? null;
}

const sorted = (rows: readonly unknown[]): string[] => rows.map((row) => JSON.stringify(row)).sort();
const NOTHING = (): TrustList => ({ sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] });

/** The list as one value, whatever order it was found in. What a site shows but doesn't run by (its words) is left out: only its fingerprint and its npm script count. */
export function trustHash(list: TrustList): string {
    const canonical = {
        sites: sorted(list.sites.map((site) => [site.key, site.fingerprint, site.npmScript])),
        hooks: sorted(list.hooks.map((hook) => [hook.file, hook.event, hook.command])),
        servers: sorted(list.servers.map((server) => [server.file, server.name, server.command])),
        gitKeys: sorted(list.gitKeys.map((entry) => [entry.key, entry.value])),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * TRUST IS GIVEN ONCE AND STAYS (Tynn #618; the owner's ruling, 2026-11-11: "once I trust a workspace, it should be trusted
 * with everything in that workspace. I should not have to keep re-trusting it every time it adds a new service or site").
 *
 * Trusted when the person has said yes to the workspace (any record of it, whatever it holds: nothing is compared), when it
 * carried over at the upgrade, or when nothing in it would run. Only the person's Untrust ends it. `hash` only says
 * whether anything would run. `changed` is always false: nothing is ever "changed since you trusted it".
 */
export function trustVerdict(record: TrustRecord, workspaceId: string, hash: string): { trusted: boolean; changed: boolean } {
    if (record.workspaces[workspaceId] !== undefined || record.carried.includes(workspaceId)) return { trusted: true, changed: false };
    return { trusted: hash === trustHash(NOTHING()), changed: false };
}
