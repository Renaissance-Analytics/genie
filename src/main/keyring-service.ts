import type { KeyringView, LinuxKeyring } from './linux-keyring.js';

/**
 * THE KEYRING CARD, AS THE HOST FOUND IT (P3.4 cut c). The secrets are in the host's keychain, so whether they can be kept is the host's to say: a window's Chromium store says
 * nothing about it. A window shows this, and its button runs the install or start here. Nothing here asks for a restart of Genie: a libsecret client sees a daemon as soon as it
 * runs, so when the keychain comes to answer, whoever reads secrets reads again (`onReady`).
 */
export interface KeyringDump {
    readonly view: KeyringView | null;
    readonly canKeepSecrets: boolean;
}

export class KeyringService {
    #keyring: LinuxKeyring | null = null;
    readonly #opening: Promise<LinuxKeyring | null>;
    readonly #listeners = new Set<(dump: KeyringDump) => void>();

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
        return { view: this.#keyring?.view() ?? null, canKeepSecrets: this.#keyring?.canKeepSecrets() ?? true };
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
