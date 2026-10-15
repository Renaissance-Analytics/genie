import { closeAction, loginItemPlan, trayNoticeDue, TRAY_NOTICE, v1LoginItemQuery, type LoginItemPlan, type LoginItemSettings } from '../core/tray-resident.js';

/**
 * TRAY-RESIDENT GENIE — the main-process wiring (decisions: core/tray-resident.ts).
 *
 * Nothing here imports `electron`: the window, the settings and the OS come in as ports, so a test
 * drives a real close sequence and counts what happened. main.ts hands it the real ones.
 */

type Value = boolean | string;

/** The settings store, as much of it as this needs. */
export interface ResidenceSettings {
    snapshot(): Record<string, Value>;
    set(key: string, value: unknown): Promise<void>;
    onChange(listener: (key: string, value: Value, workspaceId?: string) => void): () => void;
}

/** The main window, as much of it as a close needs. */
export interface ClosableWindow {
    on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
    hide(): void;
}

/**
 * Closing the main window hides it — unless a quit is under way (then the close is real, or the
 * quit would be aborted), or on macOS (its own convention). The first hide ever says so, once:
 * the marker is a setting, so "once" survives restarts.
 */
export function wireCloseToTray(win: ClosableWindow, ports: {
    readonly platform: NodeJS.Platform;
    readonly quitting: () => boolean;
    readonly settings: ResidenceSettings;
    readonly notify: (notice: { readonly title: string; readonly body: string }) => void;
}): void {
    // Held here too: the store's write is async, and two closes in quick succession must not both see "not shown".
    let noticed = false;
    win.on('close', (event) => {
        const action = closeAction(ports.platform, ports.quitting());
        if (action !== 'hide') return;
        event.preventDefault();
        win.hide();
        if (!trayNoticeDue(action, noticed || ports.settings.snapshot().tray_notice_shown === true)) return;
        noticed = true;
        void ports.settings.set('tray_notice_shown', true).catch((error: unknown) => console.error('[genie] the tray notice marker was not saved:', error));
        try { ports.notify(TRAY_NOTICE); } catch (error) { console.error('[genie] the tray notice could not be shown:', error); }
    });
}

/** The OS side of "launch at sign-in". */
export interface LoginItemPort {
    setLoginItemSettings(settings: LoginItemSettings): void;
    getLoginItemSettings(options: { readonly path?: string; readonly args?: readonly string[] }): { readonly openAtLogin: boolean };
    exists(file: string): boolean;
    writeFile(file: string, content: string): void;
    removeFile(file: string): void;
}

export interface LoginItemEnv {
    readonly platform: NodeJS.Platform;
    readonly packaged: boolean;
    readonly execPath: string;
    readonly appImage: string | null;
    readonly configHome: string;
}

export function applyLoginItem(port: LoginItemPort, plan: LoginItemPlan): void {
    if (plan.kind === 'none') return;
    if (plan.kind === 'login-item') { port.setLoginItemSettings(plan.settings); return; }
    if (plan.content === null) { if (port.exists(plan.file)) port.removeFile(plan.file); return; }
    port.writeFile(plan.file, plan.content);
}

function planFor(env: LoginItemEnv, values: Record<string, Value>): LoginItemPlan {
    return loginItemPlan({ ...env, launchAtLogin: values.launch_at_login === true, startMinimized: values.start_minimized === true });
}

/** Whether Genie 1 left a sign-in entry this Genie should honour. */
export function v1LoginItemPresent(port: LoginItemPort, env: LoginItemEnv): boolean {
    const q = v1LoginItemQuery(env);
    if (q.kind === 'none') return false;
    try {
        return q.kind === 'login-item' ? port.getLoginItemSettings(q.options).openAtLogin === true : port.exists(q.file);
    } catch {
        return false;
    }
}

/**
 * At boot: adopt Genie 1's sign-in entry if the setting is off and the entry is there (otherwise the
 * boot's apply would delete what the person turned on in Genie 1), apply the setting once — the
 * install may have moved, and the arguments follow start minimised — then follow every change of
 * either setting. A failure is reported, never a failed boot.
 */
export async function wireLoginItem(settings: ResidenceSettings, port: LoginItemPort, env: LoginItemEnv): Promise<void> {
    const safely = (what: string, fn: () => void) => { try { fn(); } catch (error) { console.error(`[genie] launch at sign-in: ${what} failed:`, error); } };
    if (settings.snapshot().launch_at_login !== true && v1LoginItemPresent(port, env)) {
        await settings.set('launch_at_login', true).catch((error: unknown) => console.error('[genie] launch at sign-in: adopting Genie 1\'s entry failed:', error));
    }
    safely('applying at boot', () => applyLoginItem(port, planFor(env, settings.snapshot())));
    settings.onChange((key, _value, workspaceId) => {
        if (workspaceId !== undefined || (key !== 'launch_at_login' && key !== 'start_minimized')) return;
        safely('applying the change', () => applyLoginItem(port, planFor(env, settings.snapshot())));
    });
}
