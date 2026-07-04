import {
    BrowserWindow,
    WebContentsView,
    session as electronSession,
    type Session,
} from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionCa } from '../remote/site-ca';
import {
    createSiteShim,
    isGenHost,
    stripHostPort,
    type GenTarget,
    type SiteShim,
} from '../remote/site-proxy';
import { getSiteCarrier, remoteListEnabledGenSites, type EnabledGenSite } from '../remote';
import { DEVICE_PRESETS, devicePreset, initialGenUrl, normalizeNavUrl } from './chrome';

/**
 * The Testing Browser (serve-local-sites Phase D, design §3a/§4) — the real remote
 * UX. Electron's bundled Chromium on a DEDICATED, in-memory `session` per host
 * connection, wrapped in Genie's own React chrome (URL bar, tabs, device presets).
 *
 * WIRING (all in MAIN; the token + CA key never reach any renderer):
 *   - `session.fromPartition('testing-browser:<connKey>')` — an IN-MEMORY session
 *     (no `persist:` prefix) so it is session-scoped: closing the window discards
 *     its cookies/cache (design §5 "trivial teardown"). ONE session per host
 *     connection = the §7-analogue `.gen` isolation (decision #2).
 *   - `session.setProxy({ proxyRules })` → the per-connection forward-proxy shim
 *     (main/remote/site-proxy.ts), which resolves `*.gen` INTO the tunnel. So the
 *     remote OS needs ZERO hosts-file/DNS entries — the proxy IS the resolver.
 *   - `session.setCertificateVerifyProc` → the per-session Genie CA
 *     (main/remote/site-ca.ts): a `*.gen` leaf is trusted ONLY when it chains to
 *     THIS session's CA, and NEVER OS-wide. Result: a real green-lock
 *     `https://tynn.gen` with a valid secure context, trusted nowhere else.
 *   - The WebContentsView tabs load `https://<name>.gen`; they carry NO Genie
 *     preload (remote site content). The CHROME window carries Genie's preload so
 *     its React toolbar can drive navigation over `testing-browser:*` IPC.
 *
 * MULTI-HOST: keyed by `connKey`, mirroring `bindWindowToConnection`, so hostA's
 * `tynn.gen` and hostB's `tynn.gen` live in separate sessions + CAs + shims.
 *
 * ═══ ELECTRON E2E GATE ═══ Everything below needs the live Electron runtime
 * (`WebContentsView`, `session`, real TLS). It is NOT unit-tested; the
 * display-independent logic (URL/preset rules → chrome.ts; the shim → CA →
 * carrier wiring → site-proxy.ts / site-ca.ts) IS. A manual tailnet smoke —
 * `https://tynn.gen` loading with a green lock in the Testing Browser — is the
 * pre-ship check (see the Phase D report).
 */

const isDev = process.env.NODE_ENV !== 'production';
/** How often to re-pull the host's enabled `.gen` set (a newly-enabled repo
 *  appears without reopening the browser). */
const SITE_REFRESH_MS = 20_000;

interface Tab {
    id: string;
    view: WebContentsView;
    url: string;
    title: string;
}

interface TestingBrowserInstance {
    connKey: string;
    hostname: string;
    window: BrowserWindow;
    session: Session;
    ca: SessionCa;
    shim: SiteShim;
    /** Live enabled-`.gen` map (lowercased genName → target) the shim resolves
     *  against. Refreshed from the host's `/api/sites` on open + on an interval. */
    genMap: Map<string, GenTarget>;
    /** The enabled sites, for the chrome's quick-nav chips. */
    sites: EnabledGenSite[];
    tabs: Tab[];
    activeTabId: string | null;
    /** The content region the chrome reserves for the active WebContentsView. */
    contentBounds: { x: number; y: number; width: number; height: number };
    /** Active device-emulation preset id. */
    presetId: string;
    refreshTimer: NodeJS.Timeout | null;
}

/** connKey → instance (one Testing Browser per host connection). */
const instances = new Map<string, TestingBrowserInstance>();
/** chrome webContents.id → connKey, so the IPC handlers resolve their instance. */
const chromeWcToConnKey = new Map<number, string>();

function instanceForChrome(wcId: number): TestingBrowserInstance | null {
    const key = chromeWcToConnKey.get(wcId);
    return key ? instances.get(key) ?? null : null;
}

/** The enabled `.gen` host names (for the chrome's URL-bar allowlist). */
function enabledGenSet(inst: TestingBrowserInstance): Set<string> {
    return new Set(inst.genMap.keys());
}

// --- open / teardown -------------------------------------------------------

/**
 * Open (or focus) the Testing Browser for a live host connection. Phase E is
 * carrier-agnostic: `getSiteCarrier` returns a DIRECT (tailnet) or a RELAY carrier
 * per the connection kind, so a Virtual Workstation with NO shared tailnet works
 * the same as a direct host. The connection must already be live (the Hosts UI
 * connected it).
 */
export async function openTestingBrowser(
    connKey: string,
    hostname: string,
): Promise<{ ok: boolean; error?: string }> {
    const existing = instances.get(connKey);
    if (existing && !existing.window.isDestroyed()) {
        existing.window.show();
        existing.window.focus();
        return { ok: true };
    }
    const carrier = getSiteCarrier(connKey);
    if (!carrier) {
        return {
            ok: false,
            error: 'No live host connection for the Testing Browser.',
        };
    }

    const ca = new SessionCa();
    // In-memory, per-connection session (no `persist:` prefix ⇒ discarded on close).
    const ses = electronSession.fromPartition(`testing-browser:${connKey}`);
    const genMap = new Map<string, GenTarget>();

    const shim = await createSiteShim({
        ca,
        carrier,
        resolveGen: (genHost) => genMap.get(genHost) ?? null,
    });

    // Route the session through the shim (it refuses non-`.gen`). Chromium keeps
    // its default loopback bypass, which we never load anyway.
    await ses.setProxy({ proxyRules: shim.proxyRules });
    // Trust a `*.gen` leaf ONLY when it chains to THIS session's CA — never OS-wide.
    ses.setCertificateVerifyProc((request, callback) => {
        const host = stripHostPort(request.hostname);
        if (isGenHost(host) && ca.verifyLeaf(request.certificate.data)) {
            callback(0); // trusted — our own session CA issued it
            return;
        }
        callback(-3); // anything else: defer to Chromium's default verdict
    });

    const win = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 720,
        minHeight: 480,
        show: false,
        title: `Genie Testing Browser — ${hostname}`,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    const inst: TestingBrowserInstance = {
        connKey,
        hostname,
        window: win,
        session: ses,
        ca,
        shim,
        genMap,
        sites: [],
        tabs: [],
        activeTabId: null,
        contentBounds: { x: 0, y: 96, width: 1200, height: 724 },
        presetId: 'fit',
        refreshTimer: null,
    };
    instances.set(connKey, inst);
    chromeWcToConnKey.set(win.webContents.id, connKey);

    win.on('closed', () => teardown(connKey));

    // NOTE: deliberately NOT `?host=` — that token flips a renderer into a remote
    // HOST window (re-pointing api() over the bridge). The chrome is a LOCAL Genie
    // window whose `testing-browser:*` IPC is resolved in main by its webContents
    // id; it reads all state from `state()`, not the URL. Use a distinct param.
    const query = `?tb=1&name=${encodeURIComponent(hostname)}`;
    if (isDev) {
        void win.loadURL(`http://localhost:8888/testing-browser${query}`);
    } else {
        void win.loadFile(path.join(__dirname, 'testing-browser.html'), { search: query.slice(1) });
    }
    win.once('ready-to-show', () => win.show());

    // Seed the enabled-`.gen` set, then open the first site (once the chrome
    // subscribes it will pull state; we also push after refresh).
    await refreshSites(inst);
    inst.refreshTimer = setInterval(() => void refreshSites(inst), SITE_REFRESH_MS);
    inst.refreshTimer.unref?.();

    const first = initialGenUrl([...inst.genMap.keys()]);
    if (first) openTab(inst, first);

    return { ok: true };
}

/** Tear one Testing Browser down: stop the refresh, close every tab view, shut the
 *  shim, and drop the instance. The in-memory session is discarded with it. */
function teardown(connKey: string): void {
    const inst = instances.get(connKey);
    if (!inst) return;
    instances.delete(connKey);
    chromeWcToConnKey.delete(inst.window.webContents.id);
    if (inst.refreshTimer) {
        clearInterval(inst.refreshTimer);
        inst.refreshTimer = null;
    }
    for (const tab of inst.tabs) destroyTab(inst, tab);
    inst.tabs = [];
    void inst.shim.close().catch(() => {});
    // Best-effort: drop any live sockets + cached data in the ephemeral session.
    void inst.session.clearStorageData().catch(() => {});
}

// --- enabled-.gen refresh --------------------------------------------------

/** Re-pull the host's enabled `.gen` sites into the shim's resolver map + push the
 *  fresh list to the chrome. Silent on failure (host locked/unreachable → []). */
async function refreshSites(inst: TestingBrowserInstance): Promise<void> {
    const sites = await remoteListEnabledGenSites(inst.connKey);
    inst.genMap.clear();
    for (const s of sites) inst.genMap.set(s.genName, { siteId: s.siteId, hostname: s.hostname });
    inst.sites = sites;
    pushState(inst);
}

// --- tab management (Electron-runtime) -------------------------------------

function openTab(inst: TestingBrowserInstance, url: string): Tab {
    const view = new WebContentsView({
        webPreferences: {
            session: inst.session,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // NO Genie preload — this is REMOTE site content, never given the bridge.
        },
    });
    const tab: Tab = { id: crypto.randomUUID(), view, url, title: url };
    inst.tabs.push(tab);
    inst.window.contentView.addChildView(view);

    const wc = view.webContents;
    const onNav = () => {
        tab.url = wc.getURL();
        pushState(inst);
    };
    wc.on('page-title-updated', (_e, title) => {
        tab.title = title;
        pushState(inst);
    });
    wc.on('did-navigate', onNav);
    wc.on('did-navigate-in-page', onNav);
    wc.on('did-start-loading', () => pushState(inst));
    wc.on('did-stop-loading', onNav);
    wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
        if (isMainFrame && code !== -3 /* not an aborted load */) {
            inst.window.webContents.send('testing-browser:load-error', {
                tabId: tab.id,
                code,
                description: desc,
                url: validatedURL,
            });
        }
    });
    // Keep new-window/target=_blank navigations inside the browser as a new tab.
    wc.setWindowOpenHandler(({ url: openUrl }) => {
        const check = normalizeNavUrl(openUrl, enabledGenSet(inst));
        if ('url' in check) openTab(inst, check.url);
        return { action: 'deny' };
    });

    void wc.loadURL(url);
    activateTab(inst, tab.id);
    return tab;
}

function destroyTab(inst: TestingBrowserInstance, tab: Tab): void {
    try {
        inst.window.contentView.removeChildView(tab.view);
    } catch {
        /* already detached */
    }
    try {
        // WebContentsView's contents must be explicitly destroyed to free the pty.
        (tab.view.webContents as unknown as { close?: () => void }).close?.();
    } catch {
        /* already gone */
    }
}

function activateTab(inst: TestingBrowserInstance, tabId: string): void {
    if (!inst.tabs.some((t) => t.id === tabId)) return;
    inst.activeTabId = tabId;
    applyLayout(inst);
    pushState(inst);
}

/** Position the active view in the reserved content area (respecting the device
 *  preset) and hide the rest. Called on activate, bounds change, preset change. */
function applyLayout(inst: TestingBrowserInstance): void {
    const cb = inst.contentBounds;
    const preset = devicePreset(inst.presetId);
    for (const tab of inst.tabs) {
        const active = tab.id === inst.activeTabId;
        tab.view.setVisible(active);
        if (!active) continue;
        if (preset.width == null || preset.height == null) {
            tab.view.setBounds(cb); // fit — fill the reserved area
        } else {
            // Emulate a device: a fixed-size viewport pinned to the content origin.
            tab.view.setBounds({
                x: cb.x,
                y: cb.y,
                width: Math.min(preset.width, cb.width),
                height: Math.min(preset.height, cb.height),
            });
        }
    }
}

// --- chrome-facing state push ----------------------------------------------

/** The snapshot the React chrome renders from (tabs + nav + enabled sites). */
function chromeState(inst: TestingBrowserInstance): unknown {
    const active = inst.tabs.find((t) => t.id === inst.activeTabId) ?? null;
    const wc = active?.view.webContents ?? null;
    return {
        connKey: inst.connKey,
        hostname: inst.hostname,
        tabs: inst.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        activeTabId: inst.activeTabId,
        loading: wc?.isLoading() ?? false,
        canGoBack: wc?.navigationHistory.canGoBack() ?? false,
        canGoForward: wc?.navigationHistory.canGoForward() ?? false,
        presetId: inst.presetId,
        presets: DEVICE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
        sites: inst.sites.map((s) => ({
            genName: s.genName,
            hostname: s.hostname,
            scheme: s.scheme,
            port: s.port,
        })),
    };
}

function pushState(inst: TestingBrowserInstance): void {
    if (inst.window.isDestroyed()) return;
    inst.window.webContents.send('testing-browser:state', chromeState(inst));
}

// --- IPC-facing actions (resolved by the CALLING chrome window) -------------

/** The current state for the chrome's mount-time read. */
export function testingBrowserState(wcId: number): unknown | null {
    const inst = instanceForChrome(wcId);
    return inst ? chromeState(inst) : null;
}

/** Navigate the active tab (opening one if none) to a `.gen` URL-bar input. */
export function testingBrowserNavigate(
    wcId: number,
    input: string,
): { ok: boolean; error?: string } {
    const inst = instanceForChrome(wcId);
    if (!inst) return { ok: false, error: 'no testing browser' };
    const check = normalizeNavUrl(input, enabledGenSet(inst));
    if ('error' in check) return { ok: false, error: check.error };
    const active = inst.tabs.find((t) => t.id === inst.activeTabId);
    if (active) void active.view.webContents.loadURL(check.url);
    else openTab(inst, check.url);
    return { ok: true };
}

export function testingBrowserBack(wcId: number): void {
    const inst = instanceForChrome(wcId);
    const wc = inst?.tabs.find((t) => t.id === inst.activeTabId)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

export function testingBrowserForward(wcId: number): void {
    const inst = instanceForChrome(wcId);
    const wc = inst?.tabs.find((t) => t.id === inst.activeTabId)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

export function testingBrowserReload(wcId: number): void {
    const inst = instanceForChrome(wcId);
    inst?.tabs.find((t) => t.id === inst.activeTabId)?.view.webContents.reload();
}

export function testingBrowserNewTab(wcId: number, input?: string): { ok: boolean; error?: string } {
    const inst = instanceForChrome(wcId);
    if (!inst) return { ok: false, error: 'no testing browser' };
    const target =
        input && input.trim()
            ? normalizeNavUrl(input, enabledGenSet(inst))
            : { url: initialGenUrl([...inst.genMap.keys()]) ?? 'about:blank' };
    if ('error' in target) return { ok: false, error: target.error };
    openTab(inst, target.url);
    return { ok: true };
}

export function testingBrowserCloseTab(wcId: number, tabId: string): void {
    const inst = instanceForChrome(wcId);
    if (!inst) return;
    const idx = inst.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = inst.tabs.splice(idx, 1);
    destroyTab(inst, tab);
    if (inst.activeTabId === tabId) {
        const next = inst.tabs[idx] ?? inst.tabs[idx - 1] ?? null;
        inst.activeTabId = next?.id ?? null;
        applyLayout(inst);
    }
    pushState(inst);
}

export function testingBrowserActivateTab(wcId: number, tabId: string): void {
    const inst = instanceForChrome(wcId);
    if (inst) activateTab(inst, tabId);
}

/** The chrome reports the reserved content region (below its toolbar/tab strip). */
export function testingBrowserSetBounds(
    wcId: number,
    bounds: { x: number; y: number; width: number; height: number },
): void {
    const inst = instanceForChrome(wcId);
    if (!inst) return;
    inst.contentBounds = {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(0, Math.round(bounds.width)),
        height: Math.max(0, Math.round(bounds.height)),
    };
    applyLayout(inst);
}

export function testingBrowserSetViewport(wcId: number, presetId: string): void {
    const inst = instanceForChrome(wcId);
    if (!inst) return;
    inst.presetId = devicePreset(presetId).id;
    applyLayout(inst);
    pushState(inst);
}

/** Refresh the enabled-`.gen` list on demand (the chrome's refresh button). */
export async function testingBrowserRefreshSites(wcId: number): Promise<void> {
    const inst = instanceForChrome(wcId);
    if (inst) await refreshSites(inst);
}
