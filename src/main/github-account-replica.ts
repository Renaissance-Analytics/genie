import { GithubNotInstalledError, GithubPermissionError, signedOutGithubView, type CreatedRepo, type GithubView, type RepoListing } from '../core/github.js';
import type { CreateRepoOptions, GithubAccountPort, GithubPage } from './github-account.js';
import type { GithubAccountDump, GithubCarried, GithubCarriedError } from './github-account-service.js';

type Call = (method: string, args: readonly unknown[]) => Promise<unknown>;

function rebuilt(carried: GithubCarriedError): Error {
    const error = carried.kind === 'not-installed'
        ? new GithubNotInstalledError(carried.account, carried.installUrl, carried.status, '')
        : new GithubPermissionError(carried.account, carried.installationId, carried.settingsUrl);
    Object.defineProperty(error, 'message', { value: carried.message });
    return error;
}

/**
 * THE GITHUB ACCOUNT AS A WINDOW SEES IT (P3.4 cut c). The view answers from the host's last word; everything else is asked, git included. It holds no token and
 * has no way to get one. The browser is the one thing it does itself, and only for GitHub's own pages, whatever the link says.
 */
export class GithubAccountReplica implements GithubAccountPort {
    readonly #call: Call;
    #view: GithubView = signedOutGithubView(null);
    #openExternal: ((url: string) => Promise<void>) | null = null;
    readonly #listeners = new Set<() => void>();

    constructor(call: Call) { this.#call = call; }

    useBrowser(open: (url: string) => Promise<void>): void { this.#openExternal = open; }

    rebase(dump: GithubAccountDump): void {
        const view = dump.view ?? signedOutGithubView(null);
        const changed = JSON.stringify(view) !== JSON.stringify(this.#view);
        this.#view = view;
        if (changed) for (const listener of [...this.#listeners]) listener();
    }

    openFromHost(url: string): void {
        if (!/^https:\/\/github\.com\//.test(url)) return;
        void this.#openExternal?.(url).catch(() => { /* The page's link is still on screen. */ });
    }

    view(): GithubView { return this.#view; }
    onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }

    async #typed<T>(method: string, args: readonly unknown[]): Promise<T> {
        const carried = await this.#call(method, args) as GithubCarried;
        if (carried.error) throw rebuilt(carried.error);
        return carried.value as T;
    }

    async startSignIn(): Promise<void> { await this.#call('startSignIn', []); }
    cancelSignIn(): void { void this.#call('cancelSignIn', []).catch(() => {}); }
    async signOut(): Promise<void> { await this.#call('signOut', []); }
    async refresh(): Promise<void> { await this.#call('refresh', []); }
    async reload(): Promise<void> { await this.#call('reload', []); }
    async openPage(target: GithubPage): Promise<void> { await this.#call('openPage', [target]); }
    repoListing(): Promise<RepoListing> { return this.#call('repoListing', []) as Promise<RepoListing>; }
    createRepo(options: CreateRepoOptions): Promise<CreatedRepo> { return this.#typed('createRepo', [options]); }
    forkRepo(options: { owner: string; repo: string; into: string }): Promise<CreatedRepo> { return this.#typed('forkRepo', [options]); }
    waitUntilReady(fullName: string): Promise<void> { return this.#typed('waitUntilReady', [fullName]); }

    /** Authenticated git, run by the host. A window hears how it ended, in git's words with every secret scrubbed there. */
    async gitClone(url: string, into: string, branch: string | null | undefined): Promise<void> { await this.#call('gitClone', [url, into, branch ?? null]); }
    gitAddSubmodule(envelope: string, url: string, at: string, branch: string | null, local: boolean | undefined): Promise<string | null> {
        return this.#call('gitAddSubmodule', [envelope, url, at, branch, local === true]) as Promise<string | null>;
    }
    async gitPushMain(path: string, url: string): Promise<void> { await this.#call('gitPushMain', [path, url]); }
}
