import { Keychain, type KeyringModule } from './keychain.js';
import { LinuxKeyring, realKeyringPorts, type KeyringState, type RealKeyringDeps } from './linux-keyring.js';
import { execFileRunner } from './toolchain-runner.js';

/**
 * GENIE-HOST'S KEYCHAIN (P3.4 cut a), with decision 3's refusal and offer: no keychain means no secret is kept, and on Linux
 * the SAME install/start flow the window's card runs (linux-keyring.ts, genie#1436) can fix it. There is no second flow: the
 * host only hands that module its own facts, reading "ready" from the keychain really answering (`Keychain.probe`), never
 * from Chromium's store, which it does not have. `restart-needed` cannot arise here: a libsecret client sees a daemon as soon
 * as it runs, with no store to pick at launch. Off Linux there is nothing to install, so the probe alone answers.
 */
export interface HostKeychainOptions {
    readonly platform?: NodeJS.Platform;
    readonly load?: () => Promise<KeyringModule>;
    readonly run?: RealKeyringDeps['run'];
    readonly exists?: RealKeyringDeps['exists'];
    readonly pathEnv?: string;
    readonly onChange?: () => void;
}

export interface HostKeychain {
    readonly keychain: Keychain;
    /** The install/start flow; null off Linux. */
    readonly keyring: LinuxKeyring | null;
    state(): KeyringState;
}

/** The same runner the window hands this flow; in genie-host it runs in-process (toolchain-runner.ts). */
const runProgram: RealKeyringDeps['run'] = (binary, args, timeoutMs) => execFileRunner(binary, args, { timeoutMs: timeoutMs ?? 5_000 })
    .then((r) => ({ exitCode: r.exitCode, stdout: r.streams.stdout, stderr: r.streams.stderr }));

export async function openHostKeychain(options: HostKeychainOptions = {}): Promise<HostKeychain> {
    const keychain = new Keychain(options.load);
    let answers = false;
    const ask = async (): Promise<void> => { answers = (await keychain.probe()).ok; };

    if ((options.platform ?? process.platform) !== 'linux') {
        await ask();
        return { keychain, keyring: null, state: () => (answers ? 'ready' : 'refused') };
    }
    const base = realKeyringPorts({
        run: options.run ?? runProgram,
        // A real backend by name, so its answer alone decides: ready, or (with a daemon running) refused.
        storage: () => ({ backend: 'gnome_libsecret', available: answers }),
        relaunch: () => {},
        ...(options.onChange ? { onChange: options.onChange } : {}),
        ...(options.exists ? { exists: options.exists } : {}),
        ...(options.pathEnv !== undefined ? { pathEnv: options.pathEnv } : {}),
    });
    const keyring = await LinuxKeyring.open({ ...base, facts: async () => { await ask(); return base.facts(); } });
    return { keychain, keyring, state: () => keyring.state() };
}
