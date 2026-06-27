import { BrowserWindow } from 'electron';
import { getTailscaleStatus } from '../tailscale';

/**
 * Work Mode — remote (Phase 2). A Genie in remote mode connects to a HOST Genie
 * over the tailnet and drives it. We deliberately REUSE the host's existing,
 * tested remote-control web app (its `/m/` surface — pair → dashboard →
 * terminals → questions) rather than re-implementing it: the remote desktop
 * simply opens a Genie-owned window pointed at `http://<host-ip>:<port>/m/`. That
 * window is same-origin to the host (zero cross-origin/CSP friction) and reuses
 * 100% of the mobile stack. A loud, persistent banner is injected so it's always
 * obvious you're controlling ANOTHER machine, not this one.
 */

/** A Genie host discovered on the tailnet (answered the `/api/ping` beacon). */
export interface GenieHost {
    /** The host's own `os.hostname()` (from the beacon). */
    hostname: string;
    /** The tailnet peer name (from `tailscale status`). */
    peerName: string;
    ip: string;
    port: number;
}

/** The default mobile/Work-Mode server port (mirrors db.ts mobile_port default). */
const DEFAULT_PORT = 51718;

/** Probe one peer's port for the unauthed Genie `/api/ping` beacon. */
async function probe(
    ip: string,
    port: number,
    peerName: string,
    timeoutMs = 1500,
): Promise<GenieHost | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`http://${ip}:${port}/api/ping`, { signal: ctrl.signal });
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as
            | { genie?: boolean; hostname?: string }
            | null;
        if (!data?.genie) return null;
        return { hostname: data.hostname || peerName, peerName, ip, port };
    } catch {
        return null; // unreachable / not a Genie host / timed out
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Discover Genie hosts on the tailnet: probe each ONLINE peer's default Work-Mode
 * port for the `/api/ping` beacon. A host only answers when its Work Mode (host /
 * mobile remote control) is ENABLED. Hosts on a non-default port aren't
 * auto-found — the UI offers manual host:port entry for those.
 */
export async function discoverHosts(): Promise<GenieHost[]> {
    const status = await getTailscaleStatus();
    if (!status.running) return [];
    const peers = status.peers.filter((p) => p.online && p.ip);
    const found = await Promise.all(
        peers.map((p) => probe(p.ip as string, DEFAULT_PORT, p.hostname || (p.ip as string))),
    );
    return found.filter((h): h is GenieHost => h !== null);
}

// Track open remote windows by host so re-connecting focuses the existing one.
const remoteWindows = new Map<string, BrowserWindow>();

/** Strip anything that could break out of the injected JS string / HTML. */
export function safeName(name: string): string {
    return String(name).replace(/[^\w .\-]/g, '').slice(0, 60) || 'a remote machine';
}

/** The injected banner that makes a remote session unmistakable. */
function bannerScript(hostname: string): string {
    const safe = safeName(hostname);
    return `(() => {
        if (document.getElementById('genie-remote-banner')) return;
        const b = document.createElement('div');
        b.id = 'genie-remote-banner';
        b.textContent = '\\u{1F534} REMOTE SESSION \\u2014 you are controlling ${safe} over Tailscale';
        Object.assign(b.style, {
            position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
            background: '#b91c1c', color: '#fff',
            font: '600 12px system-ui, -apple-system, sans-serif',
            padding: '6px 12px', textAlign: 'center', letterSpacing: '0.02em',
            boxShadow: '0 1px 8px rgba(0,0,0,0.45)', pointerEvents: 'none',
        });
        document.documentElement.appendChild(b);
    })();`;
}

/**
 * Open (or focus) a Genie-owned window driving a host's `/m/` remote-control app
 * over Tailscale. NO Genie preload is attached — the window loads the REMOTE
 * host's web app, which must never receive this machine's IPC bridge. The red
 * banner + title make it obvious you're controlling another machine.
 */
export function openRemoteWindow(host: {
    ip: string;
    port: number;
    hostname: string;
}): { ok: boolean } {
    const key = `${host.ip}:${host.port}`;
    const existing = remoteWindows.get(key);
    if (existing && !existing.isDestroyed()) {
        existing.focus();
        return { ok: true };
    }

    const w = new BrowserWindow({
        width: 1100,
        height: 760,
        show: false,
        title: `● REMOTE — controlling ${safeName(host.hostname)}`,
        backgroundColor: '#1a0b0b', // a dark-red chrome so the window reads "remote"
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Intentionally NO `preload` — never expose this machine's bridge to
            // a page served by a remote host.
        },
    });
    remoteWindows.set(key, w);
    w.on('closed', () => remoteWindows.delete(key));

    const inject = () => {
        w.webContents.executeJavaScript(bannerScript(host.hostname)).catch(() => {});
    };
    // Re-inject on every load (a full reload — e.g. after re-pair — wipes it).
    w.webContents.on('did-finish-load', inject);
    w.webContents.on('did-navigate', inject);
    w.once('ready-to-show', () => w.show());

    void w.loadURL(`http://${host.ip}:${host.port}/m/`);
    return { ok: true };
}
