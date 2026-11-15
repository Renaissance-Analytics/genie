/** INERT STUBS (Tynn #604 RED): signatures only, no behaviour. */

export const PLAYWRIGHT_BROWSERS_ENV = 'PLAYWRIGHT_BROWSERS_PATH';
export const PLAYWRIGHT_ENDPOINT_ENV = 'PW_TEST_CONNECT_WS_ENDPOINT';

export interface PlaywrightDirs {
    readonly root: string;
    readonly browsers: string;
    readonly manifest: string;
    cli(version: string): string;
}

export function playwrightDirs(_toolchainDir: string): PlaywrightDirs {
    return { root: '', browsers: '', manifest: '', cli: () => '' };
}

export function playwrightEnv(_toolchainDir: string): Record<string, string> {
    return {};
}

export type LockKind = 'package-lock' | 'pnpm' | 'yarn';

export function parseLockedPlaywright(_lockText: string, _kind: LockKind): string | null {
    return null;
}

export type BrowserSetResolution =
    | { readonly kind: 'ready'; readonly version: string }
    | { readonly kind: 'missing'; readonly version: string; readonly note: string };

export function resolveBrowserSet(_clientVersion: string, _installed: readonly string[]): BrowserSetResolution {
    return { kind: 'ready', version: '' };
}

export function planBrowserInstall(_version: string, _browsers: readonly string[], _installed: Readonly<Record<string, readonly string[]>>): { readonly download: readonly string[]; readonly have: readonly string[] } {
    return { download: [], have: [] };
}

export function serverVersionMatch(_client: string, _server: string): { readonly ok: boolean; readonly note?: string } {
    return { ok: true };
}

export interface ServerEndpoint {
    readonly port: number;
    readonly token: string;
    readonly version: string;
}

export function endpointUrl(_endpoint: Pick<ServerEndpoint, 'port' | 'token'>): string {
    return '';
}

export function playwrightChildEnv(_input: { toolchainDir: string; optIn: boolean; clientVersion: string | null; server: ServerEndpoint | null }): { readonly env: Record<string, string>; readonly note?: string } {
    return { env: {} };
}

export function serverCommand(_input: { cliDir: string; host: string; port: number; token: string }): { readonly command: string; readonly path: string } {
    return { command: '', path: '' };
}

export function decideIdle(_input: { lastActiveAt: number; now: number; idleMs: number; connections: number | null }): 'stop' | 'keep' {
    return 'keep';
}

export function countEstablished(_text: string, _port: number): number {
    return -1;
}

export function worktreeLinkDecision(_input: { mainLock: string | null; worktreeLock: string | null; worktreeHasNodeModules: boolean; mainHasNodeModules: boolean }): { readonly link: boolean; readonly reason?: string } {
    return { link: true };
}
