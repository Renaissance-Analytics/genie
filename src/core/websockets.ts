import type { AdoptedSlice } from './services.js';

/**
 * WEBSOCKETS PER WORKSPACE (§6.6, hosting ship line H8) — the pure half.
 *
 * WHAT GENIE 1 SHIPPED, and what this matches: the bundled WebSocket server is SOCKUDO (`sockudo/sockudo` 4.7.0), a
 * Pusher-protocol server — not Laravel's Reverb. Genie 1 first keyed the engine `reverb`, then renamed it, because the
 * word named a product Genie does not run and it misled a real user debugging a socket (repos/genie
 * main/__tests__/v71-websockets-not-reverb.test.ts; main/db.ts v71; genie#428, v0.7.0-beta.301). The shared
 * `genie-reverb` service that came before it was abandoned by the owner. So the engine here is `websockets`, and the
 * image is Sockudo's own.
 *
 * ## One engine, one app per workspace
 *
 * Genie 1 (main/dev-server/services/catalog.ts `WEBSOCKETS`, host-websocket.ts): ONE server for the machine; each
 * workspace that uses it gets its OWN app — id, key and secret — in the server's app list. Separation is by app: a
 * client signing with workspace A's secret cannot publish on workspace B's app. The server's app list is the desired
 * state; changing it rewrites the WHOLE config and restarts the server (host-websocket.ts `restart`). The same here,
 * except the server is a container (Genie 2 runs every engine in Docker, port isolation only): the config is a file
 * Genie writes and bind-mounts read-only, and a change restarts the container.
 *
 * - **id = key = the workspace's `ws_<slug>`** (Genie 1: service-manager.ts `host.acquire({ id: slice.identifier, key:
 *   slice.identifier, … })`). The key is the public client identifier — it rides in the browser bundle as
 *   `VITE_*_APP_KEY` — so a derived name is right for it.
 * - **secret = generated per app**, kept as the slice's `password`. Genie 1 derived it (HMAC of the app id under the
 *   engine's master, env-wiring.ts `websocketAppSecret`) so its earlier server could recompute it without a registry.
 *   Sockudo is GIVEN its apps, so nothing needs to recompute it here — and a generated secret means removing a
 *   workspace's app REVOKES it: adding it again mints a new secret, so a stale `.env` cannot sign for the new app.
 *
 * ## The env (Genie 1's names, all of them)
 *
 * env-wiring.ts `case 'websockets'` emitted the canonical `GENIE_WS_*`, `BROADCAST_CONNECTION=reverb`, and `REVERB_*`
 * — the latter kept on purpose: `REVERB_*` is Laravel's reverb-driver contract (`config/broadcasting.php` reads it in
 * every Laravel app), and Sockudo speaks the protocol that driver speaks. host-core/hosting.ts `browserWebSocketEnv`
 * added the browser's `VITE_GENIE_WS_*` and `VITE_REVERB_*` (what Laravel's `echo.js` reads). `PUSHER_*` is NOT
 * emitted, as in Genie 1: an app configured for hosted Pusher would have its real credentials silently replaced.
 *
 * What differs is the VALUES of the browser keys. Genie 1's sites ran in containers, so the browser reached the server
 * through the site layer at `websockets.<ws>.gen:443` over https. Genie 2's apps run on the host and the server is
 * published on loopback, so the browser key points at the same `127.0.0.1:<port>` the backend uses, over plain
 * ws — a browser treats loopback as a secure origin, so an `https://<site>.gen` page may open it.
 */

/** Genie 1's pinned version (catalog.ts `distribution: { project: 'sockudo/sockudo', version: '4.7.0' }`); Docker Hub publishes the same tag. */
export const SOCKUDO_IMAGE = 'sockudo/sockudo';
export const SOCKUDO_VERSION = '4.7.0';
/** Sockudo's own port: HTTP and the WebSocket upgrade on one (Genie 1's catalog `container: 6001`; the image EXPOSEs it). */
export const SOCKUDO_PORT = 6001;
/** Where Genie's config is mounted in the container — beside the image's own `/app/config`, never over it. */
export const SOCKUDO_CONFIG_TARGET = '/app/config/genie.toml';
/** The container's command: the image's binary on Genie's config (the image's default CMD names its bundled `config.json`). */
export const SOCKUDO_COMMAND: readonly string[] = ['sockudo', '--config', SOCKUDO_CONFIG_TARGET];

/** Engines whose workspaces are APPS in a config Genie writes: a slice holds no data, so dropping one loses nothing. */
export const APP_ENGINES: ReadonlySet<string> = new Set(['websockets']);

export interface WebSocketApp {
    readonly id: string;
    readonly key: string;
    readonly secret: string;
}

/** A workspace's app, from its slice: id and key are its `ws_<slug>`, the secret is its own. */
export function websocketAppOf(slice: Pick<AdoptedSlice, 'identifier' | 'password'>): WebSocketApp {
    return { id: slice.identifier, key: slice.identifier, secret: slice.password };
}

const APP_ID = /^[a-z][a-z0-9_]{0,62}$/;
const SECRET = /^[A-Za-z0-9_-]{8,128}$/;

const tomlString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Sockudo's complete config for the apps given — Genie 1's `renderSockudoConfig` (host-websocket.ts), ported: memory
 * drivers throughout (nothing to persist: connection and channel state is in memory), metrics and push off, client
 * events off, user authentication on, every origin allowed (a dev machine's sites are many `.gen` names). `host` is
 * `0.0.0.0` because it is the CONTAINER's listener; Docker publishes it on loopback only.
 *
 * Sorted by id, so the same apps always render the same text — which is what lets a caller skip a restart when nothing
 * changed. Ids and secrets are asserted to be the derived/generated kind: the day a user-supplied value reaches here it
 * fails loudly instead of becoming TOML injection.
 */
export function renderSockudoConfig(input: { readonly port: number; readonly apps: readonly WebSocketApp[] }): string {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new Error(`invalid Sockudo port: ${input.port}`);
    const apps = [...input.apps].sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set<string>();
    for (const app of apps) {
        if (!APP_ID.test(app.id) || !APP_ID.test(app.key)) throw new Error(`refusing a WebSocket app id ${JSON.stringify(app.id)}: it is not a derived workspace name`);
        if (!SECRET.test(app.secret)) throw new Error(`refusing the WebSocket app ${app.id}: its secret is not a generated one`);
        if (ids.has(app.id)) throw new Error(`duplicate WebSocket app id: ${app.id}`);
        ids.add(app.id);
    }
    const lines = [
        '# Written by Genie: the WebSocket apps of every workspace that uses this engine. Rewritten whole on each change.',
        'debug = false',
        'host = "0.0.0.0"',
        `port = ${input.port}`,
        'mode = "development"',
        'shutdown_grace_period = 2',
        '',
        '[adapter]',
        'driver = "local"',
        '',
        '[cache]',
        'driver = "memory"',
        '',
        '[queue]',
        'driver = "memory"',
        '',
        '[metrics]',
        'enabled = false',
        '',
        '[push]',
        'storage_driver = "memory"',
        'queue_driver = "memory"',
        'fcm_enabled = false',
        'apns_enabled = false',
        'webpush_enabled = false',
        'hms_enabled = false',
        'wns_enabled = false',
        '',
        '[app_manager]',
        'driver = "memory"',
        '',
        '[app_manager.array]',
    ];
    for (const app of apps) {
        lines.push(
            '[[app_manager.array.apps]]',
            `id = ${tomlString(app.id)}`,
            `key = ${tomlString(app.key)}`,
            `secret = ${tomlString(app.secret)}`,
            'enabled = true',
            '',
            '[app_manager.array.apps.policy.features]',
            'enable_client_messages = false',
            'enable_user_authentication = true',
            '',
            '[app_manager.array.apps.policy.channels]',
            'allowed_origins = ["*"]',
            '',
        );
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Every key a workspace's app puts in its env, in Genie 1's order. 21: six canonical, the driver selector, six Laravel
 * aliases, and four + four for the browser.
 */
export const WEBSOCKET_ENV_KEYS: readonly string[] = [
    'GENIE_WS_APP_ID', 'GENIE_WS_APP_KEY', 'GENIE_WS_APP_SECRET', 'GENIE_WS_HOST', 'GENIE_WS_PORT', 'GENIE_WS_SCHEME',
    'BROADCAST_CONNECTION',
    'REVERB_APP_ID', 'REVERB_APP_KEY', 'REVERB_APP_SECRET', 'REVERB_HOST', 'REVERB_PORT', 'REVERB_SCHEME',
    'VITE_GENIE_WS_APP_KEY', 'VITE_GENIE_WS_HOST', 'VITE_GENIE_WS_PORT', 'VITE_GENIE_WS_SCHEME',
    'VITE_REVERB_APP_KEY', 'VITE_REVERB_HOST', 'VITE_REVERB_PORT', 'VITE_REVERB_SCHEME',
];

/**
 * A workspace's WebSocket env in HOST form (env-wiring.ts `case 'websockets'` + hosting.ts `browserWebSocketEnv`).
 * The secret appears under the two `*_APP_SECRET` names only — never under a `VITE_` name, which a bundler ships to
 * every browser.
 */
export function websocketHostEnv(slice: Pick<AdoptedSlice, 'identifier' | 'password'>): Record<string, string> {
    const app = websocketAppOf(slice);
    // ONE secure address for every key — the browser's and the app's server side alike (WEBSOCKETS_HOST).
    const host = WEBSOCKETS_HOST;
    const port = '443';
    const scheme = 'https';
    return {
        GENIE_WS_APP_ID: app.id,
        GENIE_WS_APP_KEY: app.key,
        GENIE_WS_APP_SECRET: app.secret,
        GENIE_WS_HOST: host,
        GENIE_WS_PORT: port,
        GENIE_WS_SCHEME: scheme,
        BROADCAST_CONNECTION: 'reverb',
        REVERB_APP_ID: app.id,
        REVERB_APP_KEY: app.key,
        REVERB_APP_SECRET: app.secret,
        REVERB_HOST: host,
        REVERB_PORT: port,
        REVERB_SCHEME: scheme,
        VITE_GENIE_WS_APP_KEY: app.key,
        VITE_GENIE_WS_HOST: host,
        VITE_GENIE_WS_PORT: port,
        VITE_GENIE_WS_SCHEME: scheme,
        VITE_REVERB_APP_KEY: app.key,
        VITE_REVERB_HOST: host,
        VITE_REVERB_PORT: port,
        VITE_REVERB_SCHEME: scheme,
    };
}

/**
 * THE SHARED WEBSOCKETS SERVER'S ONE ADDRESS (the owner, 2026-10-17: "We don't need multiple wss servers and yes, always
 * WSS, not WS. All genie sites should always be secure. each workstation should have its own namespace, not server" —
 * per workspace, one address). Served by the front door with Genie's certificate; every workspace reaches the one
 * server here, over wss/https only — the browser and the app's server side alike — and is kept apart by its own APP
 * (id, key, secret), never by an address. pusher-js on an https page always uses TLS, so a plain address cannot serve
 * a browser at all (moic, 2026-10-16).
 */
export const WEBSOCKETS_HOST = 'websockets.gen';
