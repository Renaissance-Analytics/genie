import { GithubNotInstalledError, GithubPermissionError, type GithubView } from '../core/github.js';
import type { GithubAccount, GithubPage, CreateRepoOptions } from './github-account.js';
import { gitAddSubmodule, gitClone, gitPushMain, type GitAuth } from './git-ports.js';

/**
 * THE HOST'S GITHUB ACCOUNT, AS A WINDOW ASKS IT (P3.4 cut c; plan §13). What crosses the link is who is signed in, what GitHub answered and how a git command
 * ended. A token never does: there is no method that returns one, an unlisted method is refused, and authenticated git runs here, with the credential going
 * to git's environment for that one command (git-ports.ts). A window asks for the clone or the push, and hears the outcome.
 */
export interface GithubGitPorts {
    clone(url: string, into: string, auth: GitAuth | undefined, branch: string | null | undefined): Promise<void>;
    addSubmodule(envelope: string, url: string, at: string, branch: string | null, auth: GitAuth | undefined, local: boolean | undefined): Promise<string | null>;
    pushMain(path: string, auth: GitAuth | undefined): Promise<void>;
}
const REAL_GIT: GithubGitPorts = {
    clone: (url, into, auth, branch) => gitClone(url, into, auth, branch),
    addSubmodule: (envelope, url, at, branch, auth, local) => gitAddSubmodule(envelope, url, at, branch, auth, local ?? false),
    pushMain: (path, auth) => gitPushMain(path, auth),
};

export interface GithubAccountDump {
    readonly view: GithubView | null;
}
/** An error a window acts on by its type, as plain fields: an exception does not survive the link as itself. */
export type GithubCarriedError =
    | { readonly kind: 'not-installed'; readonly account: string; readonly installUrl: string; readonly status: number; readonly message: string }
    | { readonly kind: 'permission'; readonly account: string; readonly installationId: number; readonly settingsUrl: string; readonly message: string };
export interface GithubCarried {
    readonly value?: unknown;
    readonly error?: GithubCarriedError;
}

const carry = async (work: () => Promise<unknown>): Promise<GithubCarried> => {
    try {
        return { value: await work() };
    } catch (error) {
        if (error instanceof GithubNotInstalledError) return { error: { kind: 'not-installed', account: error.account, installUrl: error.installUrl, status: error.status, message: error.message } };
        if (error instanceof GithubPermissionError) return { error: { kind: 'permission', account: error.account, installationId: error.installationId, settingsUrl: error.settingsUrl, message: error.message } };
        throw error;
    }
};

export class GithubAccountService {
    #account: GithubAccount | null = null;
    readonly #opening: Promise<GithubAccount>;
    readonly #git: GithubGitPorts;
    readonly #listeners = new Set<(dump: GithubAccountDump) => void>();
    readonly #openers = new Set<(url: string) => void>();

    constructor(account: GithubAccount | Promise<GithubAccount>, options: { git?: GithubGitPorts } = {}) {
        this.#git = options.git ?? REAL_GIT;
        const adopt = (opened: GithubAccount): GithubAccount => {
            this.#account = opened;
            // The host has no browser: a page it would open goes to the window.
            opened.useBrowser(async (url) => { for (const open of [...this.#openers]) open(url); });
            const emit = (): void => { const dump = this.dump(); for (const listener of [...this.#listeners]) listener(dump); };
            opened.onChange(emit);
            emit();
            return opened;
        };
        this.#opening = account instanceof Promise ? account.then(adopt) : Promise.resolve(adopt(account));
        void this.#opening.catch(() => {});
    }

    dump(): GithubAccountDump {
        return { view: this.#account?.view() ?? null };
    }

    onEvent(listener: (dump: GithubAccountDump) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A page for the person: said to the window, which opens it. */
    onOpen(open: (url: string) => void): () => void {
        this.#openers.add(open);
        return () => { this.#openers.delete(open); };
    }

    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        const account = await this.#opening;
        switch (method) {
            case 'startSignIn': return account.startSignIn();
            case 'cancelSignIn': return account.cancelSignIn();
            case 'signOut': return account.signOut();
            case 'refresh': return account.refresh();
            case 'reload': return account.reload();
            case 'openPage': return account.openPage(args[0] as GithubPage);
            case 'repoListing': return account.repoListing();
            case 'createRepo': return carry(() => account.createRepo(args[0] as CreateRepoOptions));
            case 'forkRepo': return carry(() => account.forkRepo(args[0] as { owner: string; repo: string; into: string }));
            case 'waitUntilReady': return carry(() => account.waitUntilReady(String(args[0] ?? '')));
            case 'gitClone': {
                const url = String(args[0] ?? '');
                return this.#git.clone(url, String(args[1] ?? ''), account.cloneAuth(url) ?? undefined, (args[2] ?? null) as string | null);
            }
            case 'gitAddSubmodule': {
                const url = String(args[1] ?? '');
                return this.#git.addSubmodule(String(args[0] ?? ''), url, String(args[2] ?? ''), (args[3] ?? null) as string | null, account.cloneAuth(url) ?? undefined, args[4] === true);
            }
            case 'gitPushMain': {
                const url = String(args[1] ?? '');
                return this.#git.pushMain(String(args[0] ?? ''), account.pushAuth(url) ?? undefined);
            }
            default:
                throw new Error(`The GitHub account has no ${method}.`);
        }
    }
}
