// RED STUB (TDD): the tests in test/linux-keyring.test.ts describe this module; the implementation follows.
export type PackageManager = 'pacman' | 'apt' | 'dnf' | 'zypper';
export interface KeyringFacts { platform: NodeJS.Platform; installed: boolean; owned: boolean; activatable: boolean; backend: string | null; available: boolean }
export type KeyringState = 'ready' | 'not-installed' | 'not-running' | 'restart-needed' | 'refused';
export type KeyringStep = 'installing' | 'starting' | 'restarting';
export interface KeyringView { readonly state: Exclude<KeyringState, 'ready'>; readonly step: KeyringStep | null; readonly failure: string | null; readonly manual: string | null; readonly packages: string }
export interface InstallPlan { readonly run: readonly string[] | null; readonly manual: string | null; readonly packages: readonly string[] }
export interface KeyringPorts {
    readonly platform: NodeJS.Platform;
    facts(): Promise<Omit<KeyringFacts, 'platform'>>;
    plan(): Promise<InstallPlan>;
    exec(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stderr: string }>;
    relaunch(): void;
    onChange?(): void;
}
const todo = (): never => { throw new Error('not implemented'); };
export const KEYRING_PACKAGES: Readonly<Record<PackageManager, readonly string[]>> = { pacman: [], apt: [], dnf: [], zypper: [] };
export const START_SECRET_SERVICE_ARGV: readonly string[] = [];
export const START_DAEMON_ARGV: readonly string[] = [];
export function classifyKeyring(_f: KeyringFacts): KeyringState { return todo(); }
export function parseSecretServiceListing(_s: string): { owned: boolean; activatable: boolean } { return todo(); }
export function detectPackageManager(_o: string, _h: (b: string) => boolean): PackageManager | null { return todo(); }
export function installArgv(_p: PackageManager): string[] { return todo(); }
export function installPlan(_p: PackageManager | null, _k: string | null): InstallPlan { return todo(); }
export function markResumeSignIn(_d: string, _w: 'tynn'): void { todo(); }
export function takeResumeSignIn(_d: string): 'tynn' | null { return todo(); }
export class LinuxKeyring {
    static async open(_p: KeyringPorts): Promise<LinuxKeyring> { return todo(); }
    view(): KeyringView | null { return todo(); }
    canKeepSecrets(): boolean { return todo(); }
    onChange(_l: () => void): () => void { return todo(); }
    async fix(): Promise<void> { todo(); }
}
