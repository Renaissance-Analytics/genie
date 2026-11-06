import type { KeyringView, LinuxKeyring } from './linux-keyring.js';

/**
 * THE KEYRING CARD, AS THE HOST FOUND IT (P3.4 cut c). The secrets are in the host's keychain, so whether they can be kept is the host's to say: a window's Chromium store says
 * nothing about it. A window shows this, and its button runs the install or start here. Nothing here asks for a restart of Genie: a libsecret client sees a daemon as soon as it
 * runs, so when the keychain comes to answer, whoever reads secrets reads again (`onReady`).
 */
export interface KeyringDump {
    readonly view: KeyringView | null;
    readonly canKeepSecrets: boolean;
    /** A short word for the screen about what an unlock set going — the Genie browser restarting (Tynn story #388). */
    readonly notice?: string | null;
}

/** What the screen says while an unlock restarts the Genie browser, and when it has (the owner's visible-progress rule). */
export const BROWSER_RESTART_WORDS = {
    restarting: 'Restarting Genie’s browser to use your unlocked keyring…',
    done: 'Genie’s browser restarted with your unlocked keyring.',
} as const;
const NOTICE_CLEARS_MS = 10_000;

/**
 * A KEYRING UNLOCKED WHILE THE GENIE BROWSER RUNS (Tynn story #388): that browser read "locked" at its own start and Electron
 * never reads it again, so it is restarted — and the screen says so, then that it did, then the word clears. No browser
 * running: nothing restarts and nothing is said. Answers an unsubscribe.
 */
export function restartBrowserOnUnlock(input: {
    keyring: { state(): string; onChange(l: () => void): () => void };
    browser: { restartForKeyring(): boolean; onDown(l: () => void): () => void };
    notice: (text: string | null) => void;
    schedule?: (fn: () => void, ms: number) => void;
    log?: (line: string) => void;
}): () => void {
    const schedule = input.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.(); });
    let before = input.keyring.state();
    let offDown: (() => void) | null = null;
    const off = input.keyring.onChange(() => {
        const now = input.keyring.state();
        if (before === 'refused' && now === 'ready' && input.browser.restartForKeyring()) {
            input.log?.('keyring unlocked: the Genie browser restarts so its sites can use it');
            input.notice(BROWSER_RESTART_WORDS.restarting);
            offDown?.();
            offDown = input.browser.onDown(() => {
                offDown?.();
                offDown = null;
                input.notice(BROWSER_RESTART_WORDS.done);
                schedule(() => input.notice(null), NOTICE_CLEARS_MS);
            });
        }
        before = now;
    });
    return () => { off(); offDown?.(); };
}

export class KeyringService {
    #keyring: LinuxKeyring | null = null;
    readonly #opening: Promise<LinuxKeyring | null>;
    readonly #listeners = new Set<(dump: KeyringDump) => void>();
    #notice: string | null = null;

    /** Off Linux there is no card (`null`). Still opening: no card yet, and nothing claims secrets cannot be kept. */
    constructor(keyring: LinuxKeyring | Promise<LinuxKeyring | null>, options: { onReady?: () => void } = {}) {
        const adopt = (opened: LinuxKeyring | null): LinuxKeyring | null => {
            this.#keyring = opened;
            let ready = opened?.canKeepSecrets() ?? true;
            const emit = (): void => {
                const now = opened?.canKeepSecrets() ?? true;
                if (now && !ready) options.onReady?.();
                ready = now;
                const dump = this.dump();
                for (const listener of [...this.#listeners]) listener(dump);
            };
            opened?.onChange(emit);
            const dump = this.dump();
            for (const listener of [...this.#listeners]) listener(dump);
            return opened;
        };
        this.#opening = keyring instanceof Promise ? keyring.then(adopt) : Promise.resolve(adopt(keyring));
        void this.#opening.catch(() => {});
    }

    dump(): KeyringDump {
        return { view: this.#keyring?.view() ?? null, canKeepSecrets: this.#keyring?.canKeepSecrets() ?? true, notice: this.#notice };
    }

    /** The screen's word about what an unlock set going (`restartBrowserOnUnlock`); `null` clears it. */
    setNotice(text: string | null): void {
        if (text === this.#notice) return;
        this.#notice = text;
        const dump = this.dump();
        for (const listener of [...this.#listeners]) listener(dump);
    }

    onEvent(listener: (dump: KeyringDump) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async call(method: string, _args: readonly unknown[]): Promise<unknown> {
        const keyring = await this.#opening;
        // The button answers once its step is done or the keyring's own unlock dialog is up (Tynn story #388); Cancel ends that ask.
        if (method === 'fix') { await keyring?.press(); return null; }
        if (method === 'cancel') { keyring?.cancel(); return null; }
        throw new Error(`The keyring has no ${method}.`);
    }
}
