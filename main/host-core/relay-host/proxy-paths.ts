import type { Channel } from '../../remote/relay-protocol';

/**
 * Where a relay member's frame may land on this machine's local member-facing
 * server (genie#680). The relay host proxies onto 127.0.0.1, and a path a member
 * writes must not reach anything but the member API: never the phone app shell,
 * never another host (an absolute or scheme-relative URL), and never `/api/pair`,
 * which would ask the desktop to confirm a new OWNER device.
 *
 * Returns the path to dial, or null to refuse. What the path is ALLOWED to do is
 * then the server's decision for the member's session (`mobile/guest-access.ts`);
 * this only keeps the proxy from being pointed somewhere else.
 */
export function loopbackTarget(channel: Channel, path: string): string | null {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
    let pathname: string;
    try {
        pathname = new URL(path, 'http://loopback.invalid').pathname;
    } catch {
        return null;
    }
    // A traversal the URL parser resolved away is refused, not followed.
    if (!path.startsWith(pathname)) return null;

    switch (channel) {
        case 'rest':
            return pathname.startsWith('/api/') && pathname !== '/api/pair' && !pathname.startsWith('/api/site/') ? path : null;
        case 'events':
            return pathname === '/ws/events' ? path : null;
        case 'term':
            return pathname === '/ws/term' ? path : null;
        case 'site':
            return pathname.startsWith('/api/site/') ? path : null;
        default:
            return null;
    }
}
