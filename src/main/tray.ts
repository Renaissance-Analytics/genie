import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { withAttentionDot } from '../core/tray-attention.js';
import type { UpdateState } from './updater.js';

/**
 * THE TRAY — the one place Genie is reachable when its window is hidden behind thirty others,
 * and the one place it can always be quit from. v1 had one; the owner's first run of 2.0.0-beta.5
 * had no tray and a window with no close button, so Genie could not be closed at all except by
 * Alt+F4. A 16 px copy of Genie's logo (`.ai/design/genie-logo-white.png`, 2026-10-18)
 * embedded so the tray never depends on a file electron-builder may or may not have packed.
 */
export const TRAY_ICON_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB20lEQVR42pWTS2sTURiGn+/MpJhJqzSEQIrU4qJolaJINsWFO3+Daxdu/A26dOfO2y9QXLrQhYi7UqwXRMRLxaKRGko7lOhkZjKZ87mYMyRWK/XAuX68532/m1hrlX0OKReFEmT4j5EADwaQjFHu6wN1xKnCSh/ifOx9LxfUTePAPQuJhYMCaQS1ADz/HwqMgCfFOQemPHiVwssMJlMQb5cL1jGW+4cUXsfOpoWKGvC0C6u9EdKUcj0pLqoF+7sMnscg7j3P4WwAl1rwI1KW71sA/FLuSgYtA0c8uNmH26Gi3yGuCpcXR641DsDSNKz5LrW5Wr0eQWRhcwATBmYMNBLQHtBVFgzMzwmdNeXNQ8v8KeHEeUNQB+kMrF7bghsteLxTBCsIIBM44/wMN5TOCwi3Fcnh3MXCoAqm6UGtp9z9AsO+0q4WoCs7yucYtgZFDOJQmTspLF0wqIJ1tWAqAlePCuFPuLMMT9aV7RTu1YVvFXjmgfGFycPCVBMq1YJZnDqx1qq4fL/fBCuwuq68/QqzQ5gOldNtodkS6jMOJKOg+mWercKxJmTArU/w6CMsdJXjG8rirNBog7W/g9ldyqowVIgtHKqMKiyJYKL2J5i/9cJ4yzIG0D2a/hfGmcdNK3moQQAAAABJRU5ErkJggg==';

export interface TrayHandlers {
    readonly onOpen: () => void;
    /** Opens the window on the Settings surface — the second way to reach Settings, beside the rail row. */
    readonly onSettings: () => void;
    /** Asks the feed now (the owner, 2026-10-13: "where even is the check for updates button?"). The header chip shows what it finds. */
    readonly onCheckUpdates: () => void;
    readonly onQuit: () => void;
    /** `Resume now` for a held provider login (Tynn #794): open it at once, its held agents go on. */
    readonly onResumeLimit?: (provider: string) => void;
    /** `⬆ Update to vX…` (Tynn #761): opens Genie, where the title bar's chip downloads and restarts it. */
    readonly onUpdate?: () => void;
    /** Task Manager… (Tynn #761): every kept process across workspaces — Hosting → Processes. */
    readonly onTaskManager?: () => void;
    /** New scratch terminal (Tynn #761): a shell in the home folder, in Genie's own workspace, in a window of its own. */
    readonly onScratchTerminal?: () => void;
    /** `Log in to <provider>` for a signed-out login: the provider's own login, in a window of its own (#967). */
    readonly onProviderLogin?: (provider: string) => void;
    /** `Try <provider> again` for a login whose ACCOUNT the provider paused: every agent on it, once the account is put right. */
    readonly onAccountRetry?: (provider: string) => void;
    /** `Log in to Claude Design` while an agent waits on it (#1081): the interactive `claude`, in a window of its own. */
    readonly onDesignLogin?: () => void;
}

/** An update on offer, as the tray shows it. */
export interface TrayUpdate {
    readonly version: string;
}

/**
 * The update the tray leads with: on offer, downloading or ready (Genie 1's tray). A restart is never started from here —
 * it ends every agent's session — so the item opens Genie, where the title bar's chip asks and does it.
 */
export function trayUpdate(state: UpdateState | null): TrayUpdate | null {
    if (!state || !state.version) return null;
    return state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded' ? { version: state.version } : null;
}

/** A provider login the rate limit holds, in the words every other surface uses (core/limit-words.ts). */
export interface HeldLogin {
    readonly provider: string;
    readonly words: string;
}

export interface TrayItem {
    readonly label?: string;
    readonly type?: 'separator';
    readonly enabled?: boolean;
    readonly click?: () => void;
}

/** The login's name: the limit belongs to the account, not to the CLI. */
export function loginName(provider: string): string {
    return provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
}

/**
 * The menu, as labels and handlers — pure enough for a test to hold the verbs. A held login (Tynn #794) leads: its line,
 * then Resume now for it — the tray is where Genie is seen when its window is not.
 */
export function trayMenuTemplate(handlers: TrayHandlers, held: readonly HeldLogin[] = [], update: TrayUpdate | null = null, signedOut: readonly string[] = [], paused: readonly string[] = [], designLogin = false): TrayItem[] {
    const limits: TrayItem[] = [
        ...held.flatMap((h) => [
            { label: `${loginName(h.provider)}: ${h.words}`, enabled: false },
            { label: `Resume ${loginName(h.provider)} now`, click: () => handlers.onResumeLimit?.(h.provider) },
        ]),
        // SIGNED OUT (the owner, 2026-10-18): the login named, and its own login one click away.
        ...(handlers.onProviderLogin ? signedOut.flatMap((provider) => [
            { label: `${loginName(provider)}: signed out`, enabled: false },
            { label: `Log in to ${loginName(provider)}`, click: () => handlers.onProviderLogin?.(provider) },
        ]) : []),
        // ACCOUNT PAUSED (the owner, 2026-10-21: a payment failure): the login named, and Try again for all of its agents.
        ...(handlers.onAccountRetry ? paused.flatMap((provider) => [
            { label: `${loginName(provider)}: account paused`, enabled: false },
            { label: `Try ${loginName(provider)} again`, click: () => handlers.onAccountRetry?.(provider) },
        ]) : []),
        // CLAUDE DESIGN'S LOGIN (#1081): per machine, so named once however many agents wait on it.
        ...(handlers.onDesignLogin && designLogin ? [
            { label: 'Claude Design: login needed', enabled: false },
            { label: 'Log in to Claude Design', click: () => handlers.onDesignLogin?.() },
        ] : []),
    ];
    const offer: TrayItem[] = update && handlers.onUpdate ? [{ label: `⬆ Update to v${update.version}…`, click: handlers.onUpdate }, { type: 'separator' }] : [];
    return [
        ...offer,
        ...limits,
        ...(limits.length > 0 ? [{ type: 'separator' as const }] : []),
        { label: 'Open Genie', click: handlers.onOpen },
        ...(handlers.onScratchTerminal ? [{ label: 'New scratch terminal', click: handlers.onScratchTerminal }] : []),
        { label: 'Settings…', click: handlers.onSettings },
        ...(handlers.onTaskManager ? [{ label: 'Task Manager…', click: handlers.onTaskManager }] : []),
        { label: 'Check for updates', click: handlers.onCheckUpdates },
        { label: 'Quit Genie', click: handlers.onQuit },
    ];
}

/** The tray's tooltip: how many Deck items wait on the person (first), what is held, or just Genie. */
export function trayTooltip(held: readonly HeldLogin[], signedOut: readonly string[] = [], paused: readonly string[] = [], designLogin = false, waiting = 0): string {
    const parts = [...(waiting > 0 ? [`${waiting} waiting on you`] : []), ...held.map((h) => `${loginName(h.provider)}: ${h.words}`), ...signedOut.map((p) => `${loginName(p)}: signed out`), ...paused.map((p) => `${loginName(p)}: account paused`), ...(designLogin ? ['Claude Design: login needed'] : [])];
    return parts.length === 0 ? 'Genie' : `Genie — ${parts.join('; ')}`;
}

/**
 * The tray's two faces: Genie's mark, and the mark with the Deck's dot (core/tray-attention.ts) — the same image, so the
 * person sees one icon change, never a different one. Genie's own mark (build/tray-icon.png, shipped as an extra
 * resource) when it is there; the embedded mark is the fallback, never the default.
 */
export function trayImages(iconPath: string | null = null): { plain: NativeImage; attention: NativeImage } {
    const fromFile = iconPath ? nativeImage.createFromPath(iconPath) : null;
    const plain = fromFile && !fromFile.isEmpty() ? fromFile : nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'));
    const { width, height } = plain.getSize();
    // Electron's raw bitmap is BGRA on Windows and Linux, RGBA on macOS.
    const order = process.platform === 'darwin' ? 'rgba' : 'bgra';
    const dotted = withAttentionDot(new Uint8Array(plain.toBitmap()), width, height, order);
    const attention = nativeImage.createFromBitmap(Buffer.from(dotted), { width, height });
    return { plain, attention: attention.isEmpty() ? plain : attention };
}

export function createTray(handlers: TrayHandlers, icon: NativeImage): Tray {
    const tray = new Tray(icon);
    tray.setToolTip('Genie');
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(handlers)));
    tray.on('click', handlers.onOpen);
    return tray;
}
