import type { RemoteHost, RemoteStatus } from './genie';

/**
 * "Is this Host genuinely REMOTE?" — genie #63 rule 3, *Local never renders as
 * Remote.*
 *
 * Phase 1 makes the local Host always-on, so being host-backed stops carrying
 * any information: every Genie is. The loud red "● REMOTE — <host>" badge is a
 * statement about WHOSE MACHINE you are driving, and the only honest source for
 * that is the host's ADDRESS. A host reached over loopback is this machine — a
 * Client → localHost connection is still local, no matter that it speaks the
 * same host protocol a tailnet host does.
 *
 * This matters ahead of Phase 2, which routes the local Client through that very
 * same connection shape at 127.0.0.1: without the loopback guard the local
 * desktop would start flying the REMOTE badge the moment that lands.
 *
 * Loopback covers the IPv4 127/8 block, IPv6 `::1` (bare or bracketed), the
 * `localhost` name, and the unspecified addresses (`0.0.0.0` / `::`) a local
 * bind reports. Anything else — tailnet 100.x, a LAN IP, a MagicDNS or relay
 * hostname — is remote.
 */
export function isRemoteHost(host: RemoteHost | null | undefined): boolean {
    const raw = host?.ip?.trim().toLowerCase();
    if (!raw) return false;
    const ip = raw.replace(/^\[|\]$/g, '');
    if (ip === 'localhost' || ip.endsWith('.localhost')) return false;
    if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return false;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
    return true;
}

/**
 * Whether the titlebar REMOTE indicator should be shown: a LIVE connection to a
 * host that is genuinely on another machine. See {@link isRemoteHost}.
 */
export function shouldShowRemoteIndicator(status: RemoteStatus | null | undefined): boolean {
    return !!status?.connected && isRemoteHost(status.host);
}
