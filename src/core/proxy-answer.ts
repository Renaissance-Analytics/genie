/**
 * WHAT `session.resolveProxy()` ANSWERS (electronjs.org/docs/latest/api/session#sesresolveproxyurl), in Chromium's PAC format:
 * `DIRECT`, or routes in order, `PROXY a:1; HTTPS b:2; SOCKS5 c:3; DIRECT`. A PAC script has already run by the time this string
 * exists, so it holds for the moment it was asked, and there is nothing here to run again.
 *
 * Node's proxy agent speaks HTTP and HTTPS proxies only. SOCKS is kept as `unsupported`, by name: a route the host cannot take is
 * said, not skipped in silence. So is an answer that names a proxy and could not be read at all: reading it as direct would send
 * Tynn's token around the proxy the OS asked for. A bad route BESIDE good ones is dropped.
 *
 * NEVER CREDENTIALS. A `user:password@` in a route is dropped here, before anything can keep or print it. The proxy then answers
 * 407, and the person hears that it wants a sign-in, which the host has no prompt for.
 */
export type ProxyRoute =
    | { readonly kind: 'direct' }
    | { readonly kind: 'proxy'; readonly scheme: 'http' | 'https'; readonly host: string; readonly port: number }
    | { readonly kind: 'unsupported'; readonly scheme: string; readonly host: string; readonly port: number };

const SCHEMES: Readonly<Record<string, 'http' | 'https' | 'unsupported'>> = { PROXY: 'http', HTTPS: 'https', SOCKS: 'unsupported', SOCKS4: 'unsupported', SOCKS5: 'unsupported', QUIC: 'unsupported' };

function hostPort(text: string): { host: string; port: number } | null {
    const bare = text.slice(text.lastIndexOf('@') + 1);
    const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/.exec(bare);
    if (!match) return null;
    const port = Number(match[2]);
    return port >= 1 && port <= 65_535 ? { host: match[1]!, port } : null;
}

function routeOf(entry: string): ProxyRoute | null {
    if (/^direct$/i.test(entry)) return { kind: 'direct' };
    const [word, target, ...rest] = entry.split(/\s+/);
    const scheme = SCHEMES[(word ?? '').toUpperCase()];
    const where = target !== undefined && rest.length === 0 ? hostPort(target) : null;
    if (!scheme || !where) return null;
    return scheme === 'unsupported' ? { kind: 'unsupported', scheme: word!.toLowerCase(), ...where } : { kind: 'proxy', scheme, ...where };
}

export function parseProxyAnswer(answer: string): ProxyRoute[] {
    const entries = answer.split(';').map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) return [{ kind: 'direct' }];
    const routes = entries.map(routeOf).filter((route): route is ProxyRoute => route !== null);
    if (routes.length > 0) return routes;
    // No credentials can be in what is kept: an unreadable answer's text is cut at any `@` word.
    return [{ kind: 'unsupported', scheme: 'unreadable', host: entries.join('; ').split(/\s+/).map((word) => (word.includes('@') ? '(hidden)' : word)).join(' ').slice(0, 120), port: 0 }];
}

/** A route as a person reads it. */
export function routeLabel(route: ProxyRoute): string {
    if (route.kind === 'direct') return 'direct';
    return route.port === 0 ? route.host : `${route.host}:${route.port}`;
}

/** The form that is kept: the same format, with nothing but what the routes hold. */
export function renderProxyAnswer(routes: readonly ProxyRoute[]): string {
    return routes.map((route) => {
        if (route.kind === 'direct') return 'DIRECT';
        if (route.kind === 'proxy') return `${route.scheme === 'https' ? 'HTTPS' : 'PROXY'} ${route.host}:${route.port}`;
        return route.port === 0 ? route.host : `${route.scheme.toUpperCase()} ${route.host}:${route.port}`;
    }).join('; ');
}
