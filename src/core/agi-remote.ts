import type { GithubView } from './github.js';

/**
 * WHERE A NEW WORKSPACE'S `<slug>.agi` GOES (Add workspace parity items 10 + 11) — the pure half.
 *
 * Genie 1 (AddWorkspaceModal.tsx :379-471, workspace-onboarding.ts containerRepoPlan, InteractiveUpgradeWizard.tsx
 * :183-220, 1719-1787, GitHubConnect.tsx OwnerSelect): a new workspace could be backed up to its own `<owner>/<slug>.agi`
 * on GitHub (made, set as `origin`, the first commit pushed), sent to a remote the person pasted, or kept on the machine.
 * The owner picker listed the person and every org the App was installed on, and said when the chosen account had no
 * installation, with the install one click away.
 *
 * The owner, 2026-10-21: "creating the repo in github is not required. users should be able to work off-grid if they need
 * to with local models". So None is a first-class choice, the DEFAULT whenever there is no GitHub sign-in, and nothing
 * downstream assumes a remote. Signed in, the default is Genie 1's: GitHub, under the person, private.
 *
 * What happens after the choice (main/agi-remote-host.ts) is reported as `Published`: the workspace exists and is
 * registered whatever GitHub, git or Tynn answer, and each step that failed is named in that service's own words.
 */

export type RemoteChoice =
    /** Off-grid: no remote at all. */
    | { readonly kind: 'none' }
    /** Genie creates `<owner>/<slug>.agi` with the GitHub sign-in (or reuses it, a retry), sets it as origin, pushes main. */
    | { readonly kind: 'github'; readonly owner: string; readonly private: boolean }
    /** A remote the person already has: set as origin, main pushed to it. GitHub is never asked. */
    | { readonly kind: 'paste'; readonly url: string };

/** The step that failed: GitHub's create, git setting origin, git's push, Tynn's declare-envelope. */
export type PublishStep = 'github' | 'remote' | 'push' | 'tynn';

export interface PublishProblem {
    readonly step: PublishStep;
    /** In the service's own words (GitHub's message, git's stderr, Tynn's answer), with what Genie was doing. */
    readonly message: string;
    /** The account the Genie AOS app is not installed on, when that is why GitHub refused — the screen offers the install. */
    readonly account?: string;
}

export interface Published {
    /** The origin set on the workspace, or `null` (None, or GitHub refused before there was a repository). */
    readonly remote: string | null;
    /** The repository GitHub made (or the one already there, `created: false`). */
    readonly repo: { readonly fullName: string; readonly htmlUrl: string; readonly created: boolean } | null;
    /** `main` reached the remote. */
    readonly pushed: boolean;
    /**
     * Tynn: `declared` (the URL is on the project), `not-linked` (no `tynn.projectId` — not Tynn's business), `no-remote`
     * (linked, but there is no URL to declare), `failed` (a problem says why).
     */
    readonly tynn: 'declared' | 'not-linked' | 'no-remote' | 'failed';
    readonly problems: readonly PublishProblem[];
}

/** An account GitHub could hold the repository under. `installed`: the App is there (`null` = not read from GitHub yet). */
export interface OwnerOption {
    readonly login: string;
    readonly personal: boolean;
    readonly installed: boolean | null;
}

/** GitHub's rule for a user or org name: letters, digits and single dashes, not starting with a dash; at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const signedInLogin = (github: GithubView | null | undefined): string | null =>
    github?.status === 'signed-in' && github.user && github.user.login ? github.user.login : null;

/** None unless signed in to GitHub; signed in, Genie 1's default — GitHub, under the person, private. */
export function defaultRemoteChoice(github: GithubView | null | undefined): RemoteChoice {
    const login = signedInLogin(github);
    return login ? { kind: 'github', owner: login, private: true } : { kind: 'none' };
}

/**
 * Genie 1's OwnerSelect: the person first, then each organisation the App is installed on. The person stays listed even
 * without an installation of their own — marked not installed, so the screen can offer the install for exactly them
 * instead of failing later. Installations not read yet: `installed: null`, never a guessed "no".
 */
export function githubOwnerOptions(github: GithubView | null | undefined): OwnerOption[] {
    const login = signedInLogin(github);
    if (!login) return [];
    const installs = github!.installations;
    const me = login.toLowerCase();
    const personal: OwnerOption = { login, personal: true, installed: installs === null ? null : installs.some((i) => !i.isOrg && i.account.toLowerCase() === me) };
    const orgs = (installs ?? []).filter((i) => i.isOrg).map((i): OwnerOption => ({ login: i.account, personal: false, installed: true }));
    return [personal, ...orgs];
}

/** A choice as the window sent it, checked; `null` = not one Genie understands. A pasted URL is trimmed. */
export function parseRemoteChoice(raw: unknown): RemoteChoice | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.kind === 'none') return { kind: 'none' };
    if (o.kind === 'github') {
        if (typeof o.owner !== 'string' || !GITHUB_LOGIN.test(o.owner) || typeof o.private !== 'boolean') return null;
        return { kind: 'github', owner: o.owner, private: o.private };
    }
    if (o.kind === 'paste') return typeof o.url === 'string' ? { kind: 'paste', url: o.url.trim() } : null;
    return null;
}

/** Why the choice cannot be used yet, in words; `null` = it can. */
export function remoteChoiceProblem(choice: RemoteChoice): string | null {
    if (choice.kind === 'github') return GITHUB_LOGIN.test(choice.owner) ? null : 'Choose the GitHub account or organisation that will own the repository.';
    if (choice.kind === 'paste') {
        const url = choice.url.trim();
        if (url === '') return 'Paste the URL of the repository to push to, or choose None.';
        if (/\s/.test(url)) return 'A repository URL has no spaces in it.';
        // git would read a leading dash as one of its own options.
        if (url.startsWith('-')) return `"${url}" is not a repository URL.`;
    }
    return null;
}

/** Genie 1's plan line: where the repository goes, or that the workspace stays on this machine. */
export function remotePlanText(choice: RemoteChoice, folder: string): string {
    if (choice.kind === 'github') return `Backed up to GitHub as ${choice.owner}/${folder} (${choice.private ? 'private' : 'public'}), pushed once it exists.`;
    if (choice.kind === 'paste') return `Pushed to ${choice.url.trim()} as origin once it is made.`;
    return 'Kept on this machine. You can add a remote later.';
}
