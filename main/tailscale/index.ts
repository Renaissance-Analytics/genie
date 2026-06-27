import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const pexecFile = promisify(execFile);

/**
 * Tailscale lifecycle management — Work Mode (host ⇄ remote desktop) needs Genie
 * to MANAGE Tailscale, not just detect the tailnet IP (see ./mobile/tailnet.ts,
 * which is detection-only). This module shells out to the `tailscale` CLI to read
 * status and bring the node online, so the Work Mode settings can surface the
 * tailnet + reachable peers and a one-click "connect" without a separate app.
 *
 * The JSON mapping (`parseTailscaleStatus`) is PURE so it's unit-tested without a
 * real tailnet; the CLI-invoking wrappers are thin around it.
 */

export interface TailnetPeer {
    hostname: string;
    ip: string | null;
    online: boolean;
    os: string;
}

export interface TailscaleStatus {
    /** The `tailscale` CLI was found on this machine. */
    installed: boolean;
    /** BackendState === 'Running' — the node is up + authenticated. */
    running: boolean;
    /** This node's tailnet identity (null before the first `up`). */
    self: { ip: string | null; hostname: string; online: boolean } | null;
    peers: TailnetPeer[];
    /** A login URL Tailscale surfaces when the node needs interactive auth. */
    authUrl?: string | null;
}

/** First IPv4 in a TailscaleIPs[] (the list also carries the IPv6 ULA). */
function firstV4(ips?: string[]): string | null {
    return (ips ?? []).find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? null;
}

/** Resolve the `tailscale` CLI path for this platform, or null when not installed. */
export function tailscaleCliPath(): string | null {
    if (process.platform === 'win32') {
        const p = 'C:\\Program Files\\Tailscale\\tailscale.exe';
        return fs.existsSync(p) ? p : null;
    }
    if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
            '/usr/local/bin/tailscale',
            '/opt/homebrew/bin/tailscale',
        ];
        return candidates.find((c) => fs.existsSync(c)) ?? null;
    }
    // Linux: the CLI is on PATH (the package installs to /usr/bin/tailscale).
    return 'tailscale';
}

/**
 * Map `tailscale status --json` to Genie's shape. PURE — fed a JSON string,
 * never touches the CLI — so the field mapping is unit-tested directly. The CLI
 * JSON exposes `BackendState`, `Self`, `Peer{}` (keyed by node key), each with
 * `TailscaleIPs[]` (IPv4 first), `HostName`, `Online`, `OS`. Malformed input maps
 * to a safe "not running, no peers" result rather than throwing.
 */
export function parseTailscaleStatus(json: string): Omit<TailscaleStatus, 'installed'> {
    let data: {
        BackendState?: string;
        AuthURL?: string;
        Self?: { TailscaleIPs?: string[]; HostName?: string; Online?: boolean };
        Peer?: Record<string, { TailscaleIPs?: string[]; HostName?: string; Online?: boolean; OS?: string }>;
    };
    try {
        data = JSON.parse(json);
    } catch {
        return { running: false, self: null, peers: [] };
    }

    const self = data.Self
        ? {
              ip: firstV4(data.Self.TailscaleIPs),
              hostname: data.Self.HostName ?? '',
              online: !!data.Self.Online,
          }
        : null;

    const peers: TailnetPeer[] = Object.values(data.Peer ?? {}).map((p) => ({
        hostname: p.HostName ?? '',
        ip: firstV4(p.TailscaleIPs),
        online: !!p.Online,
        os: p.OS ?? '',
    }));

    return {
        running: data.BackendState === 'Running',
        self,
        peers,
        authUrl: data.AuthURL ?? null,
    };
}

/** Read the tailnet status. `installed: false` when the CLI isn't present. */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
    const cli = tailscaleCliPath();
    if (!cli) return { installed: false, running: false, self: null, peers: [] };
    try {
        const { stdout } = await pexecFile(cli, ['status', '--json'], {
            windowsHide: true,
            timeout: 8000,
        });
        return { installed: true, ...parseTailscaleStatus(stdout) };
    } catch (e) {
        // `tailscale status` exits non-zero when stopped / needs-login but still
        // prints the JSON on stdout — parse that before giving up.
        const stdout = (e as { stdout?: string })?.stdout;
        if (stdout) return { installed: true, ...parseTailscaleStatus(stdout) };
        return { installed: true, running: false, self: null, peers: [] };
    }
}

/**
 * Bring this node online (`tailscale up`). Returns the login URL when interactive
 * auth is needed (Tailscale prints it to stderr) so the caller can open it.
 */
export async function tailscaleUp(): Promise<{ ok: boolean; authUrl?: string | null; message?: string }> {
    const cli = tailscaleCliPath();
    if (!cli) return { ok: false, message: 'Tailscale is not installed.' };
    try {
        await pexecFile(cli, ['up'], { windowsHide: true, timeout: 30000 });
        return { ok: true };
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
        const url = /(https:\/\/login\.tailscale\.com\/[^\s]+)/.exec(out)?.[1] ?? null;
        if (url) return { ok: false, authUrl: url, message: 'Tailscale needs you to log in.' };
        return { ok: false, message: (err.message ?? 'tailscale up failed').slice(0, 300) };
    }
}
