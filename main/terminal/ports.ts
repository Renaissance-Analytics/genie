/**
 * Ports — the injected interfaces that keep the terminal CORE runtime-agnostic.
 *
 * The terminal core (manager / sessions / shells / host-lifecycle / host-client)
 * must never import `electron` or `../db`. Instead it receives these small ports
 * and EMITS events for the things that used to be direct DB writes. Genie's
 * adapter (genie-adapter.ts + ipc.ts) is the ONE place that builds the Electron /
 * SQLite implementations and subscribes to the events to persist + broadcast.
 *
 * This is Phase 1 of the @particle-academy/fancy-term-host extraction (see
 * .ai/_discovery/fancy-term-host-extraction.md §3): inverting the coupling so the
 * core can be lifted into a package near-mechanically. The shapes here match the
 * brief's §3 interfaces verbatim.
 */

/**
 * Read-only settings access. Replaces the core's old `getAllSettings()` reach
 * into `../db`. The adapter implements `{ get: k => getAllSettings()[k] }`.
 */
export interface SettingsProvider {
    get(key: string): string | undefined;
}

/**
 * At-rest cipher for snapshot bytes (T1). The adapter wraps Electron
 * `safeStorage`; a plain-node consumer could pass a passthrough or libsodium
 * implementation. `isAvailable()` mirrors `safeStorage.isEncryptionAvailable()`
 * so the core can still take the plaintext-magic fallback when encryption is
 * unavailable, exactly as before.
 */
export interface Encryptor {
    isAvailable(): boolean;
    encrypt(b: Buffer): Buffer;
    decrypt(b: Buffer): Buffer;
}

/**
 * Everything the snapshot store (T1) needs that used to come from `electron`:
 * the base directory (was `app.getPath('userData')`) and the cipher (was
 * `safeStorage`). The store appends `/sessions` under `baseDir` itself, matching
 * the historical on-disk path.
 */
export interface SnapshotStoreConfig {
    baseDir: string;
    encryptor: Encryptor;
}

/**
 * The detached-host spawn surface (T3). The connect-or-spawn-or-fallback LOGIC
 * is core; only these three OS/Electron-specific operations are injected:
 *   - resolveHostScript(): dev vs asar.unpacked path resolution.
 *   - spawnDetached(): the ABI-correct exec (Electron: execPath +
 *     ELECTRON_RUN_AS_NODE), detached + unref.
 *   - userDataDir(): the directory pidfile/socket live under (was
 *     app.getPath('userData')).
 */
export interface HostSpawner {
    resolveHostScript(): string | null;
    spawnDetached(scriptPath: string, env: Record<string, string>): void;
    userDataDir(): string;
}
