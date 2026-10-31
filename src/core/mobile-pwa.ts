/**
 * THE PHONE AS AN INSTALLABLE APP, ONE PER HOST (the owner, 2026-10-30: "i need the mobile PWA for hosts"; genie#1346).
 *
 * Every Genie host serves its own app at `/mobile`: its own manifest, named after the host, so two workstations added
 * to one phone's home screen are two apps (each is also its own origin — its MagicDNS name). The service worker caches
 * the APP SHELL ONLY. Agent chat, files and tokens never pass through it: they ride the WebSocket, which a service worker
 * does not see, and the token lives in the page's storage, never in a cache. The page itself is network-first, so a
 * reopened app gets the newest shell whenever the host answers — and when it does not, the cached shell shows
 * "Reconnecting", never a stale picture of the agents dressed as live.
 */

export const PWA_THEME = '#0b0b0f';

export interface MobileManifest {
    id: string;
    name: string;
    short_name: string;
    description: string;
    start_url: string;
    scope: string;
    display: 'standalone';
    orientation: 'portrait';
    background_color: string;
    theme_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: 'any' | 'maskable' }>;
}

/** This host's manifest: `Genie — <host>`, the host as its home-screen label, standalone, scoped to `/mobile`. */
export function mobileManifest(hostName: string): MobileManifest {
    const host = hostName.trim() || 'Genie';
    return {
        id: '/mobile',
        name: `Genie — ${host}`,
        short_name: host.length <= 12 ? host : host.slice(0, 12),
        description: `Steer the agents on ${host} from your phone.`,
        start_url: '/mobile',
        scope: '/mobile',
        display: 'standalone',
        orientation: 'portrait',
        background_color: PWA_THEME,
        theme_color: PWA_THEME,
        icons: [
            { src: '/mobile/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/mobile/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/mobile/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    };
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The shared renderer page, as the phone gets it at `/mobile`: the manifest, a PHONE viewport (index.html has none — a
 * phone drew it 980 px wide and zoomed out), the home-screen tags named after the host, the title, and a CSP that admits
 * the manifest (`default-src 'none'` otherwise blocks it). The desktop's page is never touched.
 */
export function mobileHtml(html: string, hostName: string): string {
    const host = escapeHtml(hostName.trim() || 'Genie');
    const head = [
        '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />',
        '<link rel="manifest" href="/mobile/manifest.webmanifest" />',
        `<meta name="theme-color" content="${PWA_THEME}" />`,
        '<meta name="mobile-web-app-capable" content="yes" />',
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        `<meta name="apple-mobile-web-app-title" content="${host}" />`,
        '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
        '<link rel="apple-touch-icon" href="/mobile/apple-touch-icon.png" />',
    ].join('\n        ');
    return html
        .replace("default-src 'none';", "default-src 'none'; manifest-src 'self';")
        .replace(/<title>[^<]*<\/title>/, `<title>Genie — ${host}</title>`)
        .replace('</head>', `        ${head}\n    </head>`);
}

/** What the worker does with a path on its own origin: the shell's hashed assets and icons from cache, the page from the network first, everything else not at all. */
export function shellPolicy(pathname: string): 'cache-first' | 'network-first' | null {
    if (pathname === '/mobile' || pathname === '/mobile/') return 'network-first';
    if (/^\/(?:mobile\/)?assets\/[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(pathname) && !pathname.includes('..')) return 'cache-first';
    if (/^\/mobile\/(?:icon-[a-z0-9-]+|apple-touch-icon)\.png$/.test(pathname)) return 'cache-first';
    return null;
}

/** The service worker, served at `/mobile/sw.js` (scope `/mobile`, `Service-Worker-Allowed`). The policy is the one above, verbatim. */
export const MOBILE_SW = `'use strict';
const SHELL = 'genie-mobile-shell-v1';
const shellPolicy = ${shellPolicy.toString()};
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    const policy = shellPolicy(url.pathname);
    if (policy === 'cache-first') {
        event.respondWith(caches.open(SHELL).then((cache) => cache.match(request).then((hit) => hit || fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        }))));
    } else if (policy === 'network-first') {
        event.respondWith(fetch(request).then((response) => {
            if (response.ok) { const copy = response.clone(); caches.open(SHELL).then((cache) => cache.put('/mobile', copy)); }
            return response;
        }).catch(() => caches.open(SHELL).then((cache) => cache.match('/mobile')).then((hit) => hit || Response.error())));
    }
});
`;
