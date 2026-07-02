import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { tailscaleCliPath } from '../tailscale';

/**
 * Tailscale-issued TLS for the Mobile server.
 *
 * Tailscale can mint a real, browser-TRUSTED cert for this node's MagicDNS name
 * (e.g. `alphar.tail1e6127.ts.net`) via `tailscale cert`, so the phone can load
 * the mobile UX over HTTPS (no self-signed warning) — which also lets the browser
 * use `wss` for the terminal/dashboard streams. A cert canNOT cover a raw 100.x
 * tailnet IP, so HTTPS MUST be addressed by the MagicDNS name.
 *
 * FAIL-OPEN: any failure here (MagicDNS off, HTTPS-certs not enabled on the
 * tailnet, CLI missing/error) returns null and the server falls back to today's
 * http-over-WireGuard — still fully encrypted by Tailscale, so it's an acceptable
 * fallback, not a downgrade to on-the-wire plaintext.
 *
 * The pure helpers (normalizeDnsName / shouldRenew / buildMobileUrl) are unit-
 * tested; the CLI-invoking bits (magicDnsName / ensureCert) are manual-verify-only
 * (they need a real tailnet + the HTTPS cert capability).
 */

const pexecFile = promisify(execFile);

/** Strip a trailing dot (MagicDNS names are FQDNs) + surrounding space; empty → null. */
export function normalizeDnsName(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim().replace(/\.+$/, '');
    return t.length > 0 ? t : null;
}

/**
 * Whether a cert expiring at `notAfter` should be renewed now: within
 * `thresholdDays` of expiry, already expired, or an UNKNOWN expiry (null/NaN →
 * renew, conservatively). Pure → unit-tested.
 */
export function shouldRenew(
    notAfter: Date | null,
    now: Date = new Date(),
    thresholdDays = 30,
): boolean {
    if (!notAfter || Number.isNaN(notAfter.getTime())) return true;
    const msLeft = notAfter.getTime() - now.getTime();
    return msLeft <= thresholdDays * 24 * 60 * 60 * 1000;
}

/**
 * Build the phone URL. HTTPS uses the MagicDNS name (a cert can't cover a raw
 * 100.x IP); otherwise the tailnet IP over http. Null when there's nothing to
 * bind to. Pure → unit-tested (this IS the transport→URL selection).
 */
export function buildMobileUrl(opts: {
    secure: boolean;
    dnsName: string | null;
    ip: string | null;
    port: number | null;
}): string | null {
    const { secure, dnsName, ip, port } = opts;
    if (!port) return null;
    if (secure && dnsName) return `https://${dnsName}:${port}/m/`;
    if (ip) return `http://${ip}:${port}/m/`;
    return null;
}

/** This node's MagicDNS name (`Self.DNSName`, trailing dot stripped), or null. */
export async function magicDnsName(): Promise<string | null> {
    const cli = tailscaleCliPath();
    if (!cli) return null;
    const readDns = (stdout: string): string | null => {
        try {
            const data = JSON.parse(stdout) as { Self?: { DNSName?: string } };
            return normalizeDnsName(data.Self?.DNSName);
        } catch {
            return null;
        }
    };
    try {
        const { stdout } = await pexecFile(cli, ['status', '--json'], {
            windowsHide: true,
            timeout: 8000,
        });
        return readDns(stdout);
    } catch (e) {
        // `tailscale status` exits non-zero when stopped but still prints JSON.
        const stdout = (e as { stdout?: string })?.stdout;
        return stdout ? readDns(stdout) : null;
    }
}

/** A resolved Tailscale cert for the mobile server. */
export interface MobileCert {
    certFile: string;
    keyFile: string;
    /** Parsed cert expiry, or null when it couldn't be read. */
    notAfter: Date | null;
    /** The MagicDNS name the cert is for (what HTTPS must be addressed by). */
    dnsName: string;
}

/** Where the cert/key live: `<userData>/mobile-tls`. */
function certDir(userDataDir: string): string {
    return path.join(userDataDir, 'mobile-tls');
}

/**
 * Obtain (or renew) a Tailscale cert for this node's MagicDNS name, written under
 * `<userData>/mobile-tls`. Returns null on ANY failure (→ the server falls back to
 * http). `tailscale cert` renews in place when re-run, so this doubles as renewal.
 *
 * SECURITY: the private key is written user-only (best-effort chmod 600; on Windows
 * the userData dir is already per-user). FUTURE: seal the key via the KMS/Encryptor
 * (main/secrets/store) once the server reads it through that path, so it never sits
 * as a plain PEM on disk.
 */
export async function ensureCert(userDataDir: string): Promise<MobileCert | null> {
    const cli = tailscaleCliPath();
    if (!cli) return null;
    const dnsName = await magicDnsName();
    if (!dnsName) return null;

    const dir = certDir(userDataDir);
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        return null;
    }
    try {
        await pexecFile(cli, ['cert', '--cert-file', certFile, '--key-file', keyFile, dnsName], {
            windowsHide: true,
            timeout: 60_000,
        });
    } catch {
        // HTTPS certs not enabled on the tailnet, rate-limited, etc. → fail open.
        return null;
    }
    // Lock down the private key (best-effort; a KMS-sealed key is the follow-up).
    try {
        fs.chmodSync(keyFile, 0o600);
    } catch {
        /* Windows / unsupported chmod — the per-user userData dir is the guard */
    }
    let notAfter: Date | null = null;
    try {
        const parsed = new Date(new X509Certificate(fs.readFileSync(certFile)).validTo);
        notAfter = Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch {
        notAfter = null;
    }
    return { certFile, keyFile, notAfter, dnsName };
}
