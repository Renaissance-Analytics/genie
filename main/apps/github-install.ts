/**
 * PURE. Installing a Genie App from GitHub (Tynn #250, P4).
 *
 * This is the moment untrusted third-party code arrives on someone's machine. The
 * owner's requirement is a two-step confirmation **a human must perform**, so the
 * shape is:
 *
 *   1. A REVIEW the person reads — what it is, where it came from, what will run.
 *   2. A deliberate act: typing the app's own slug. Not a button; a button is a
 *      thing that gets clicked past.
 *   3. The OS consent modal for the permissions themselves.
 *
 * Three gates an agent cannot click through, and the middle one cannot be passed
 * without having read the review — which is why it is the slug and not "yes".
 *
 * ## What the review shows, and why
 *
 * A permission list is not enough. `services[].command` is an argv that will
 * EXECUTE on this machine, and no capability covers it — it is not a Genie tool
 * call, it is a process. Burying it would leave the most dangerous line in the
 * manifest the one nobody reads, so commands are their own section, above
 * everything else.
 *
 * The exact COMMIT is shown, not just the ref. "main" is whatever happens to be
 * there later; what is being installed is one commit, and the review should say
 * which.
 */

import { APP_CAPABILITIES, findCapability, type AppCapability } from './capabilities';
import type { AppManifest } from './manifest';

export interface GithubSource {
    owner: string;
    repo: string;
    /** `github.com/owner/repo` — what the review shows a person to check. */
    origin: string;
    /** The URL to clone. */
    cloneUrl: string;
}

const HTTPS_GITHUB = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const SSH_GITHUB = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/**
 * Read owner/repo out of a GitHub URL, or null.
 *
 * GitHub only — not out of snobbery about hosts, but because the review SAYS
 * GitHub, and a review that names the wrong provenance is worse than no review.
 * The anchored patterns matter: `github.com.evil.test` contains `github.com`.
 */
export function parseGithubSource(url: string): GithubSource | null {
    const trimmed = (url ?? '').trim();
    const match = HTTPS_GITHUB.exec(trimmed) ?? SSH_GITHUB.exec(trimmed);
    if (!match) return null;

    const [, owner, repo] = match;
    if (!owner || !repo) return null;
    return {
        owner,
        repo,
        origin: `github.com/${owner}/${repo}`,
        cloneUrl: trimmed,
    };
}

export interface GithubInstallReview {
    origin: string;
    /** The full commit being installed. */
    commit: string;
    /** The first 7, for display beside the full one. */
    shortCommit: string;
    /** The ref asked for — a branch or tag, which is NOT what gets installed. */
    ref: string;
    name: string;
    slug: string;
    version: string;
    description?: string;
    /**
     * Every command that will run on this machine, as a readable line.
     *
     * Its own field, above the permissions, because an argv is code execution and
     * no capability in the model covers it.
     */
    commands: string[];
    highRisk: AppCapability[];
    standard: AppCapability[];
    /** Things that widen reach beyond the app itself, in plain sentences. */
    escalations: string[];
    /** What the person must type to proceed. */
    confirmPhrase: string;
}

export function buildGithubReview(input: {
    source: GithubSource;
    commit: string;
    ref: string;
    manifest: AppManifest;
}): GithubInstallReview {
    const { manifest } = input;

    const declared = manifest.permissions.capabilities
        .map((key) => findCapability(key))
        .filter((c): c is AppCapability => Boolean(c))
        .sort((a, b) => APP_CAPABILITIES.indexOf(a) - APP_CAPABILITIES.indexOf(b));

    const escalations: string[] = [];
    if (manifest.permissions.scope === 'workstation') {
        escalations.push(
            'It asks to act on EVERY workspace on this machine, including projects it knows nothing about.',
        );
    }
    if (manifest.permissions.scope === 'workspaces') {
        const named = manifest.permissions.workspaces ?? [];
        escalations.push(
            `It asks to act on ${named.length} workspace${named.length === 1 ? '' : 's'} besides its own: ${named.join(', ')}.`,
        );
    }
    if (manifest.frontend.browserExposed) {
        escalations.push(
            'It asks to be reachable from your normal browser, which installs a certificate and edits your hosts file.',
        );
    }

    return {
        origin: input.source.origin,
        commit: input.commit,
        shortCommit: input.commit.slice(0, 7),
        ref: input.ref,
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        ...(manifest.description ? { description: manifest.description } : {}),
        // Joined for reading, from the LITERAL argv the manifest declared — the
        // manifest never carries a shell string, and this is display only.
        commands: (manifest.services ?? []).map((s) => s.command.join(' ')),
        highRisk: declared.filter((c) => c.risk === 'high'),
        standard: declared.filter((c) => c.risk !== 'high'),
        escalations,
        confirmPhrase: manifest.slug,
    };
}

/**
 * Did a human confirm this install?
 *
 * They must type the app's own slug, which cannot be produced without having read
 * the review. Whitespace and casing are forgiven — the point is a deliberate act,
 * not a spelling test, and being pedantic about case only teaches people to paste,
 * which is the opposite of reading.
 *
 * Re-checked in the MAIN process on the way in, never trusted from whatever
 * enabled the button: a renderer bug, or a window being driven, must not be able
 * to skip the one gate that exists to require a person.
 */
export function verifyHumanConfirmation(
    typed: string,
    manifest: Pick<AppManifest, 'slug'> | null | undefined,
): boolean {
    if (!manifest?.slug) return false;
    const given = (typed ?? '').trim().toLowerCase();
    return given.length > 0 && given === manifest.slug.trim().toLowerCase();
}
