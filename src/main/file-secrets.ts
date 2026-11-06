import { Keychain, type KeyringModule } from './keychain.js';

/** Not built yet: the tests come first. */
const NOT_YET = 'the file secret backend is not built yet';

export const SECRET_FORMAT_VERSION = 1;
export const SECRET_IV_BYTES = 12;
export const SECRET_TAG_BYTES = 16;
export const SECRET_KEY_BYTES = 32;

export function sealSecret(_key: Buffer, _plain: Buffer): Buffer { throw new Error(NOT_YET); }
export function openSealedSecret(_key: Buffer, _blob: Buffer): Buffer { throw new Error(NOT_YET); }
export function secretFileName(_service: string, _name: string): string { throw new Error(NOT_YET); }
export function keyFileTooOpen(_mode: number): boolean { throw new Error(NOT_YET); }
export function secretsDir(_home: string): string { throw new Error(NOT_YET); }

export interface FileSecretsOptions {
    readonly keyFile: string;
    readonly dir: string;
    readonly platform?: NodeJS.Platform;
    readonly ownerOnly?: (file: string) => Promise<boolean>;
    readonly statMode?: (file: string) => Promise<number>;
}

export async function openFileSecrets(_options: FileSecretsOptions): Promise<KeyringModule> { throw new Error(NOT_YET); }

export type SecretBackendChoice =
    | { readonly kind: 'os' }
    | { readonly kind: 'file'; readonly keyFile: string; readonly dir: string }
    | { readonly kind: 'refused'; readonly reason: string };

export function chooseSecretBackend(_env: NodeJS.ProcessEnv, _home: string): SecretBackendChoice { throw new Error(NOT_YET); }

export interface SecretKeychainOptions {
    readonly loadOs?: () => Promise<KeyringModule>;
    readonly platform?: NodeJS.Platform;
    readonly ownerOnly?: (file: string) => Promise<boolean>;
}

export type OpenedSecrets =
    | { readonly kind: 'os' | 'file'; readonly keychain: Keychain }
    | { readonly kind: 'refused'; readonly reason: string };

export async function openSecretKeychain(_env: NodeJS.ProcessEnv, _home: string, _options: SecretKeychainOptions = {}): Promise<OpenedSecrets> { throw new Error(NOT_YET); }
