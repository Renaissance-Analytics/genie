/**
 * THE OS KEYCHAIN (the host split, P3.4 cut a; plan §13): Windows Credential Manager and the Linux Secret Service, through
 * @napi-rs/keyring, for genie-host — which cannot use Electron's safeStorage. Named entries, not blobs. Imports nothing from
 * Electron; this is the one file that imports the library or builds an entry (a source guard, test/keychain.test.ts).
 *
 * THE PIN IS THE POINT. By default on Linux an entry falls back to the kernel keyutils store when no Secret Service runs, and
 * that store "will not persist across reboots": a write and its read-back would both succeed, and the secret would be gone
 * at the next reboot. Pinned, no Secret Service is a failure, which decision 3 turns into a refusal and an offer to install
 * or start one (linux-keyring.ts). There is no other place a secret could go: nothing here writes a file.
 *
 * THREE ANSWERS, NEVER TWO. `missing` means the keychain answered and has no such entry; `unavailable` means it did not answer.
 * A locked keychain must never read as signed out.
 */

export const KEYCHAIN_SERVICE = 'Genie';
export const ENTRY_OPTIONS = { linux: { store: 'secret-service' } } as const;

/** The refusal, in words a person acts on. A reason from below is appended; it never carries a value. */
const NO_KEYCHAIN = 'Genie needs a keyring to keep your sign-ins safe, and it did not answer, so nothing was saved';

/** What is kept, by name. The agents' and the workstations' are one entry each. */
export type SecretName = 'tynn/pairing' | 'github/access' | 'github/refresh' | `tynn/agent/${string}` | `workstation/${string}`;

export type KeychainRead =
    | { readonly kind: 'value'; readonly value: string }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unavailable'; readonly reason: string };
export type KeychainResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The library, as far as this file uses it: injectable, so tests never load a native module. */
export interface KeyringModule {
    readonly AsyncEntry: new (service: string, username: string, options: typeof ENTRY_OPTIONS) => {
        getPassword(): Promise<string | null | undefined>;
        setPassword(password: string): Promise<void>;
        deletePassword(): Promise<boolean>;
    };
}

/** An entry never written: reading it asks whether the keychain answers, and changes nothing. */
const PROBE_NAME = 'genie/probe';

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Keychain {
    readonly #load: () => Promise<KeyringModule>;
    #module: Promise<KeyringModule> | null = null;

    constructor(load: () => Promise<KeyringModule> = () => import('@napi-rs/keyring') as unknown as Promise<KeyringModule>) {
        this.#load = load;
    }

    async #entry(name: string) {
        // A load that failed is tried again next time (a package just installed, a module that was briefly unreadable).
        this.#module ??= this.#load().catch((error: unknown) => { this.#module = null; throw error; });
        const { AsyncEntry } = await this.#module;
        return new AsyncEntry(KEYCHAIN_SERVICE, name, ENTRY_OPTIONS);
    }

    async #read(name: string): Promise<KeychainRead> {
        try {
            const value = await (await this.#entry(name)).getPassword();
            return value === null || value === undefined ? { kind: 'missing' } : { kind: 'value', value };
        } catch (error) {
            return { kind: 'unavailable', reason: said(error) };
        }
    }

    get(name: SecretName): Promise<KeychainRead> {
        return this.#read(name);
    }

    async set(name: SecretName, value: string): Promise<KeychainResult> {
        if (value.length === 0) return { ok: false, reason: 'An empty secret is not kept: reading it back could not tell it from nothing.' };
        try {
            await (await this.#entry(name)).setPassword(value);
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: `${NO_KEYCHAIN}: ${said(error)}` };
        }
    }

    /** Gone either way: deleting what is not there is fine. */
    async delete(name: SecretName): Promise<KeychainResult> {
        try {
            await (await this.#entry(name)).deletePassword();
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: `${NO_KEYCHAIN}: ${said(error)}` };
        }
    }

    /** Does the keychain answer? A missing entry means it did. */
    async probe(): Promise<KeychainResult> {
        const read = await this.#read(PROBE_NAME);
        return read.kind === 'unavailable' ? { ok: false, reason: read.reason } : { ok: true };
    }
}
