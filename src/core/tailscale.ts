/**
 * WHERE THE HOST LISTENS (§6.8) — the remote socket binds to this machine's Tailscale address and is
 * advertised by its MagicDNS name: a device on the tailnet reaches it, nothing on the LAN or the
 * internet does, and the tailnet's WireGuard is the encryption. No Tailscale → no address; the host
 * never falls back to every interface.
 */

export type TailscaleStatus = { ok: true; ip: string; dnsName: string } | { ok: false; reason: string };

export const REMOTE_PATH = '/genie';
/** The one port the host's socket uses; a device types `<magicdns>:7421`. */
export const REMOTE_PORT = 7421;

export function parseTailscaleStatus(json: string): TailscaleStatus {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return { ok: false, reason: 'tailscale status did not answer JSON' };
    }
    const status = raw as { BackendState?: unknown; Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
    if (status.BackendState !== 'Running') return { ok: false, reason: `Tailscale is not running (BackendState ${String(status.BackendState ?? 'unknown')})` };
    const ips = Array.isArray(status.Self?.TailscaleIPs) ? (status.Self!.TailscaleIPs as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const ip = ips.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
    if (!ip) return { ok: false, reason: 'Tailscale reports no IPv4 address for this machine' };
    const dns = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
    return { ok: true, ip, dnsName: dns || ip };
}

/**
 * An address the socket may bind: Tailscale's CGNAT block 100.64.0.0/10 (every tailnet node's IPv4, Genie 1's
 * `isCgnatIp`, main/mobile/tailnet.ts:31 at v0.7.0-beta.342) or the loopback. Never a LAN, public or wildcard address,
 * whatever `tailscale status` happens to report (genie#1346).
 */
export function bindableAddress(ip: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return false;
    const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if ([a, b, c, d].some((n) => n > 255)) return false;
    if (a === 127) return true;
    return a === 100 && b >= 64 && b <= 127;
}

export function remoteListenAddress(status: TailscaleStatus, port: number): { bind: string; url: string } | null {
    if (!status.ok || !bindableAddress(status.ip)) return null;
    return { bind: status.ip, url: `ws://${status.dnsName}:${port}${REMOTE_PATH}` };
}
