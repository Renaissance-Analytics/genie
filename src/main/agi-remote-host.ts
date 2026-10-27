import { join } from 'node:path';
import type { PublishProblem, Published, RemoteChoice } from '../core/agi-remote.js';
import { GithubNotInstalledError, GithubPermissionError, type CreatedRepo } from '../core/github.js';
import type { CreateRepoOptions } from './github-account.js';

/**
 * A NEW ENVELOPE TO ITS OWN REMOTE (Add workspace parity items 10 + 11) — the main-process half of core/agi-remote.ts.
 *
 * Genie 1 (AddWorkspaceModal.tsx :401-471; create-agi.ts pushEnvelopeToOrigin): create the `<slug>.agi` repository on
 * GitHub, set it as `origin`, push `main` with `-u`. The owner (2026-10-21) added Tynn: once the `.agi` repository exists
 * (created, or a pasted URL), a workspace linked to a Tynn project records it there with `POST
 * /api/v1/projects/declare-envelope {project_id, envelope_repository_url}` (MeApiController::declareEnvelope — idempotent,
 * never replaces an envelope the project already has, 422 for a URL that is not an `.agi` remote).
 *
 * Runs AFTER the workspace is made and registered, so nothing here can un-make it: every failure is a `PublishProblem`
 * naming its step in the service's own words, and the steps that can still run do. GitHub refusing stops the rest (there
 * is no repository to point at); a failed push still declares the URL, which is real (the repository exists, or it is
 * the person's own). None does nothing at all — no remote, no GitHub, no Tynn.
 */

export interface AgiRemotePorts {
    git: {
        /** `git remote add origin <url>` in the workspace; rejects with git's own words. */
        setOrigin(path: string, url: string): Promise<void>;
        /** `git push -u origin main`, with the GitHub sign-in's credential where it may write (main.ts); git's words on failure. */
        pushMain(path: string, url: string): Promise<void>;
    };
    /** The GitHub sign-in's writer, or `null` when signed out (main/github-account.ts). */
    github(): { createRepo(opts: CreateRepoOptions): Promise<CreatedRepo> } | null;
    /** The signed-in Tynn session (main/tynn-account.ts); absent on a host without Tynn. */
    tynn?: {
        status(): { readonly signedIn: boolean };
        request(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
    } | undefined;
    readJson(path: string): Promise<unknown | null>;
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The workspace's Tynn project (`tynn.projectId` in its project.json), or `null`. */
async function linkedProject(ports: AgiRemotePorts, path: string): Promise<string | null> {
    const manifest = await ports.readJson(join(path, 'project.json'));
    const tynn = typeof manifest === 'object' && manifest !== null ? (manifest as { tynn?: { projectId?: unknown } }).tynn : undefined;
    return typeof tynn?.projectId === 'string' && tynn.projectId.length > 0 ? tynn.projectId : null;
}

/** Tynn's answer in words: Laravel's `message` (a 422 says which field and why), else its `error` code, with the status. */
async function tynnWords(res: { status: number; json(): Promise<unknown> }): Promise<string> {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no body: the status says it */ }
    const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const said = typeof o.message === 'string' && o.message ? o.message : typeof o.error === 'string' && o.error ? o.error : null;
    return said ? `Tynn answered ${res.status}: ${said}` : `Tynn answered ${res.status}`;
}

/**
 * `at.name` is the envelope's folder (`<slug>.agi`) — the repository's name on GitHub, as Genie 1 named it.
 */
export async function publishEnvelope(ports: AgiRemotePorts, at: { path: string; name: string }, remote: RemoteChoice): Promise<Published> {
    const problems: PublishProblem[] = [];
    const linked = await linkedProject(ports, at.path);
    if (remote.kind === 'none') return { remote: null, repo: null, pushed: false, tynn: linked ? 'no-remote' : 'not-linked', problems };

    let url: string;
    let repo: Published['repo'] = null;
    if (remote.kind === 'github') {
        const target = `${remote.owner}/${at.name}`;
        const github = ports.github();
        if (!github) {
            problems.push({ step: 'github', message: `Genie did not create ${target}: sign in to GitHub in Settings → Accounts → GitHub first. The workspace is on this machine; you can add a remote later.` });
            return { remote: null, repo: null, pushed: false, tynn: linked ? 'no-remote' : 'not-linked', problems };
        }
        try {
            const made = await github.createRepo({ owner: remote.owner, name: at.name, private: remote.private, description: `Genie workspace ${at.name}` });
            url = made.cloneUrl;
            repo = { fullName: made.fullName, htmlUrl: made.htmlUrl, created: made.created };
        } catch (error) {
            problems.push({
                step: 'github',
                message: `Genie could not create ${target} on GitHub: ${words(error)}`,
                ...(error instanceof GithubNotInstalledError ? { account: error.account } : {}),
                ...(error instanceof GithubPermissionError ? { approve: { installationId: error.installationId } } : {}),
            });
            return { remote: null, repo: null, pushed: false, tynn: linked ? 'no-remote' : 'not-linked', problems };
        }
    } else {
        url = remote.url.trim();
    }

    try {
        await ports.git.setOrigin(at.path, url);
    } catch (error) {
        problems.push({ step: 'remote', message: `Genie could not set ${url} as the workspace's origin: ${words(error)}` });
        return { remote: null, repo, pushed: false, tynn: linked ? 'no-remote' : 'not-linked', problems };
    }

    let pushed = false;
    try {
        await ports.git.pushMain(at.path, url);
        pushed = true;
    } catch (error) {
        problems.push({ step: 'push', message: `The workspace is on this machine with ${url} as its origin, but git could not push main to it: ${words(error)}` });
    }

    let tynn: Published['tynn'] = 'not-linked';
    if (linked) {
        if (!ports.tynn || !ports.tynn.status().signedIn) {
            tynn = 'failed';
            problems.push({ step: 'tynn', message: `${url} was not recorded on the Tynn project: Genie is not signed in. Sign in to Tynn under Settings → Accounts → Tynn.` });
        } else {
            try {
                const res = await ports.tynn.request('/api/v1/projects/declare-envelope', { method: 'POST', body: { project_id: linked, envelope_repository_url: url } });
                if (res.ok) tynn = 'declared';
                else {
                    tynn = 'failed';
                    problems.push({ step: 'tynn', message: `Tynn did not record ${url} on the project: ${await tynnWords(res)}` });
                }
            } catch (error) {
                tynn = 'failed';
                problems.push({ step: 'tynn', message: `Tynn could not be reached to record ${url} on the project: ${words(error)}` });
            }
        }
    }
    return { remote: url, repo, pushed, tynn, problems };
}
