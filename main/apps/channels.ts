/**
 * The two IPC channel names a GApp's bridge uses (Tynn #250).
 *
 * A module of its own, with NO imports, and that is the whole point.
 *
 * `app-preload.ts` is bundled as a separate webpack entry and loaded into a
 * third-party page's SANDBOXED window, where there is no Node and no filesystem.
 * When it took these constants from `bridge.ts` it pulled the entire main-process
 * graph in behind them — `ipcMain`, the sqlite layer, the MCP protocol — and the
 * preload died on its first `require` of a native module. The page then loaded
 * fine with NO `window.genieApp` at all.
 *
 * That failure was quiet in the worst way: the security assertion "`window.genie`
 * is absent" passed, because a preload that never ran exposes nothing either. The
 * E2E now asserts the bridge is PRESENT in the same breath, so a dead preload can
 * never again read as a locked-down one.
 *
 * Keep this file a leaf. Anything imported here is imported into that window.
 */

export const APP_CALL_CHANNEL = 'gapp:call';
export const APP_ME_CHANNEL = 'gapp:me';
