import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Keychain, type KeyringModule } from './keychain.js';
import { isOwnerOnlyFile } from './private-credentials.js';

/**
 * THE FILE SECRET BACKEND (the host split, P10.1a): genie-host's keychain on a host with no OS keychain, such as a cloud
 * workstation. Chosen ONLY by `GENIE_SECRET_BACKEND=file` together with `GENIE_SECRET_KEY_FILE=<path>`; with the variable
 * unset the keychain is the OS's, exactly as on the desktop. Nothing falls back to this, and this falls back to nothing: a
 * keychain that does not answer refuses the secret (keychain.ts), and a file backend that is misconfigured stops the host
 * before it starts (genie-host.ts), in words that say what to fix.
 *
 * ONE FILE PER ENTRY, under `<home>/secrets/`. A file's name is the SHA-256 of the entry's service and name, in hex: an entry
 * name is never a path, so `../` or a separator in it cannot leave the directory, and two names that differ only in case
 * stay two files on Windows, where file names ignore case.
 *
 * THE FORMAT, raw bytes, no text encoding: `[version 1, one byte][IV, 12 bytes][GCM tag, 16 bytes][ciphertext]`, AES-256-GCM
 * under a key of 32 raw bytes, with a fresh random IV per write and the value as UTF-8. The same layout the cloud host's own
 * sealed files use, so either can read the other's. Any change to a file, or the wrong key, fails the tag: the read is
 * refused in words and nothing is returned.
 *
 * THE KEY IS THE OPERATOR'S. Genie never creates, repairs or rotates it. A key file others could read is refused: on POSIX
 * any group or other bit; on Windows anything but an owner-only ACL (private-credentials.ts reads it, and changes nothing).
 *
 * No value reaches a log line or an error: reasons name the entry and the file, never what is in it.
 */

export const SECRET_FORMAT_VERSION = 1;
export const SECRET_IV_BYTES = 12;
export const SECRET_TAG_BYTES = 16;
export const SECRET_KEY_BYTES = 32;
const HEADER_BYTES = 1 + SECRET_IV_BYTES + SECRET_TAG_BYTES;
const CIPHER = 'aes-256-gcm';
const UNREADABLE = 'could not be decrypted';

/** Seal a value: the layout above, a fresh IV each time. */
export function sealSecret(key: Buffer, plain: Buffer): Buffer {
    const iv = randomBytes(SECRET_IV_BYTES);
    const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: SECRET_TAG_BYTES });
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([SECRET_FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Open a sealed value, or throw in words: too short, another version, or a tag that does not match (a changed file, the wrong key). */
export function openSealedSecret(key: Buffer, blob: Buffer): Buffer {
    if (blob.length < HEADER_BYTES) throw new Error(`The secret ${UNREADABLE}: its file is ${blob.length} bytes, shorter than the ${HEADER_BYTES}-byte header.`);
    if (blob[0] !== SECRET_FORMAT_VERSION) throw new Error(`The secret ${UNREADABLE}: its file is format version ${blob[0]}, and this Genie reads version ${SECRET_FORMAT_VERSION}.`);
    try {
        const decipher = createDecipheriv(CIPHER, key, blob.subarray(1, 1 + SECRET_IV_BYTES), { authTagLength: SECRET_TAG_BYTES });
        decipher.setAuthTag(blob.subarray(1 + SECRET_IV_BYTES, HEADER_BYTES));
        return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]);
    } catch {
        throw new Error(`The secret ${UNREADABLE}: the key is not the one it was sealed with, or the file was changed.`);
    }
}

/** An entry's file name: a hash, never the name, so no name is a path. */
export function secretFileName(service: string, name: string): string {
    return `${createHash('sha256').update(JSON.stringify([service, name]), 'utf8').digest('hex')}.secret`;
}

/** Any group or other bit on a key file is too open. */
export function keyFileTooOpen(mode: number): boolean {
    return (mode & 0o077) !== 0;
}

/** Where the entries live. */
export function secretsDir(home: string): string {
    return join(home, 'secrets');
}

const REFUSED = 'Genie will not start with GENIE_SECRET_BACKEND=file';
const refused = (why: string): Error => new Error(`${REFUSED}: ${why}`);
const code = (error: unknown): string => ((error as NodeJS.ErrnoException | null)?.code ?? 'an error');

export interface FileSecretsOptions {
    readonly keyFile: string;
    readonly dir: string;
    readonly platform?: NodeJS.Platform;
    /** Windows' answer (private-credentials.ts). A test seam. */
    readonly ownerOnly?: (file: string) => Promise<boolean>;
    /** POSIX: the key file's mode. A test seam; absent = the open file's own. */
    readonly statMode?: (file: string) => Promise<number>;
}

/** The key, checked before a byte of it is read: there, a file, owner-only, 32 bytes. Anything else is a refusal that says what to fix. */
async function readKey(options: FileSecretsOptions, platform: NodeJS.Platform): Promise<Buffer> {
    const given = options.keyFile;
    const path = resolve(given);
    const make = platform === 'win32'
        ? `Put ${SECRET_KEY_BYTES} random bytes there, readable by your account only`
        : `Put ${SECRET_KEY_BYTES} random bytes there, readable by this user only (for example: head -c ${SECRET_KEY_BYTES} /dev/urandom > ${given} && chmod 600 ${given})`;
    let handle: FileHandle;
    try {
        handle = await open(path, 'r');
    } catch (error) {
        if (code(error) === 'ENOENT') throw refused(`the key file ${given} (GENIE_SECRET_KEY_FILE) does not exist. ${make}.`);
        throw refused(`the key file ${given} (GENIE_SECRET_KEY_FILE) could not be opened (${code(error)}). It must be readable by the user Genie runs as.`);
    }
    try {
        const entry = await handle.stat();
        if (!entry.isFile()) throw refused(`the key file ${given} (GENIE_SECRET_KEY_FILE) is not a file. ${make}.`);
        if (platform === 'win32') {
            if (!(await (options.ownerOnly ?? isOwnerOnlyFile)(path))) {
                throw refused(`the key file ${given} (GENIE_SECRET_KEY_FILE) is not owner-only: other accounts may read it. Give it a protected ACL that grants your account alone (for example: icacls "${given}" /inheritance:r /grant:r "%USERNAME%:F").`);
            }
        } else {
            const mode = options.statMode ? await options.statMode(path) : entry.mode;
            if (keyFileTooOpen(mode)) {
                const shown = (mode & 0o777).toString(8).padStart(4, '0');
                throw refused(`the key file ${given} (GENIE_SECRET_KEY_FILE) can be read by other users (mode ${shown}). Make it this user's only: chmod 600 ${given}`);
            }
        }
        const key = await handle.readFile();
        if (key.length !== SECRET_KEY_BYTES) {
            throw refused(`the key file ${given} (GENIE_SECRET_KEY_FILE) is ${key.length} bytes; it must be exactly ${SECRET_KEY_BYTES} raw bytes (not hex or base64 text).`);
        }
        return key;
    } finally {
        await handle.close();
    }
}

/** The directory: made if absent (0700 on POSIX), and a directory this user can read and write, or a refusal. */
async function prepareDir(dir: string, platform: NodeJS.Platform): Promise<string> {
    const path = resolve(dir);
    const fix = `It holds the sealed secrets; it must be a directory the user Genie runs as can read and write.`;
    try {
        await mkdir(path, { recursive: true, mode: 0o700 });
        if (!(await stat(path)).isDirectory()) throw new Error('ENOTDIR');
        if (platform !== 'win32') await chmod(path, 0o700);
        await access(path, constants.R_OK | constants.W_OK);
    } catch (error) {
        throw refused(`the secrets directory ${path} could not be used (${error instanceof Error && error.message === 'ENOTDIR' ? 'not a directory' : code(error)}). ${fix}`);
    }
    return path;
}

/**
 * Open the backend: the key and the directory are checked NOW, so a misconfiguration stops the host at start rather than at
 * its first secret. What comes back is a keyring module for keychain.ts's `Keychain`, which keeps its three answers (a value,
 * missing, unavailable), its size limit and its probe exactly as for the OS keychain.
 */
export async function openFileSecrets(options: FileSecretsOptions): Promise<KeyringModule> {
    const platform = options.platform ?? process.platform;
    const key = await readKey(options, platform);
    const dir = await prepareDir(options.dir, platform);

    class FileEntry {
        readonly #name: string;
        readonly #file: string;
        readonly #stem: string;

        constructor(service: string, name: string) {
            this.#name = name;
            const fileName = secretFileName(service, name);
            this.#file = join(dir, fileName);
            this.#stem = fileName.slice(0, -'.secret'.length);
        }

        async getPassword(): Promise<string | null> {
            let blob: Buffer;
            try {
                blob = await readFile(this.#file);
            } catch (error) {
                if (code(error) === 'ENOENT') return null;
                throw new Error(`${this.#name}: its file could not be read (${code(error)}).`);
            }
            try {
                return openSealedSecret(key, blob).toString('utf8');
            } catch (error) {
                throw new Error(`${this.#name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        /** Staged beside it at 0600 and renamed over it: a reader sees the old value or the new, never half of one. */
        async setPassword(value: string): Promise<void> {
            const temp = join(dir, `${this.#stem}.${randomUUID()}.tmp`);
            let staged = false;
            try {
                const handle = await open(temp, 'wx', 0o600);
                staged = true;
                try {
                    await handle.writeFile(sealSecret(key, Buffer.from(value, 'utf8')));
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                await rename(temp, this.#file);
                staged = false;
            } catch (error) {
                throw new Error(`${this.#name}: it could not be written (${code(error)}).`);
            } finally {
                if (staged) await rm(temp, { force: true }).catch(() => {});
            }
        }

        async deletePassword(): Promise<boolean> {
            try {
                await rm(this.#file);
                return true;
            } catch (error) {
                if (code(error) === 'ENOENT') return false;
                throw new Error(`${this.#name}: it could not be deleted (${code(error)}).`);
            }
        }
    }

    return { AsyncEntry: FileEntry } as unknown as KeyringModule;
}

export type SecretBackendChoice =
    | { readonly kind: 'os' }
    | { readonly kind: 'file'; readonly keyFile: string; readonly dir: string }
    | { readonly kind: 'refused'; readonly reason: string };

/** Which store, from the environment alone. Unset or empty is the OS keychain; a value it does not know is a refusal, never a guess. */
export function chooseSecretBackend(env: NodeJS.ProcessEnv, home: string): SecretBackendChoice {
    const backend = env['GENIE_SECRET_BACKEND'] ?? '';
    if (backend === '') return { kind: 'os' };
    if (backend !== 'file') {
        return { kind: 'refused', reason: `Genie will not start: GENIE_SECRET_BACKEND is "${backend}", and the one value it knows is "file". Unset it to use the system keychain.` };
    }
    const keyFile = env['GENIE_SECRET_KEY_FILE'] ?? '';
    if (keyFile === '') {
        return { kind: 'refused', reason: `${REFUSED}: it needs GENIE_SECRET_KEY_FILE, the path to a ${SECRET_KEY_BYTES}-byte key readable by this user only.` };
    }
    return { kind: 'file', keyFile, dir: secretsDir(home) };
}

export interface SecretKeychainOptions {
    /** The OS keychain's library. A test seam; absent = keychain.ts's own. */
    readonly loadOs?: () => Promise<KeyringModule>;
    readonly platform?: NodeJS.Platform;
    readonly ownerOnly?: (file: string) => Promise<boolean>;
}

export type OpenedSecrets =
    | { readonly kind: 'os' | 'file'; readonly keychain: Keychain }
    | { readonly kind: 'refused'; readonly reason: string };

/** genie-host's keychain: the OS's, or the files, or a refusal to start. The OS keychain is never loaded on the file path. */
export async function openSecretKeychain(env: NodeJS.ProcessEnv, home: string, options: SecretKeychainOptions = {}): Promise<OpenedSecrets> {
    const choice = chooseSecretBackend(env, home);
    if (choice.kind === 'refused') return choice;
    if (choice.kind === 'os') return { kind: 'os', keychain: options.loadOs ? new Keychain(options.loadOs) : new Keychain() };
    try {
        const module = await openFileSecrets({
            keyFile: choice.keyFile,
            dir: choice.dir,
            ...(options.platform ? { platform: options.platform } : {}),
            ...(options.ownerOnly ? { ownerOnly: options.ownerOnly } : {}),
        });
        return { kind: 'file', keychain: new Keychain(async () => module) };
    } catch (error) {
        return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
}
