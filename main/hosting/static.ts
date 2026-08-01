import http from 'node:http';
import https from 'node:https';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './paths';
import { assignPort, hostedOrigin } from './ports';
import type {
    BoundServer,
    HostedSite,
    HostedStatus,
    HttpListener,
    ListenOptions,
    SiteRuntime,
    TlsMaterial,
} from './types';

/**
 * The STATIC {@link SiteRuntime} adapter — serves a built frontend
 * (`vite build` → `dist/`) at the same stable same-origin URL, in-process.
 *
 * Why this is a separate backend rather than "FrankenPHP with `file_server`":
 * FrankenPHP can certainly serve static files, but requiring it would mean a
 * ~60 MB download and an extracted PHP runtime before Genie can preview a plain
 * React app that needs no PHP at all. Most workspace sites are exactly that. So
 * the static case has zero external dependencies and works the moment Genie is
 * installed, on every OS, with no binary to fetch, verify or upgrade.
 *
 * The polymorphism is the point: one of these backends manages an OS process,
 * the other manages a socket, and the caller — and the Testing Browser seam —
 * cannot tell which is serving a given site.
 */

// --- pure: path resolution -------------------------------------------------

export interface ResolvedStatic {
    /** ABSOLUTE path to the file to serve. */
    filePath: string;
    /** True when the SPA fallback was used (affects caching + status code). */
    fallback: boolean;
}

/**
 * Map a request path to a file inside `root`, or to the SPA shell.
 *
 * PURE and security-relevant: this is the only place a URL becomes a filesystem
 * path, so it is where directory traversal has to be stopped. Percent-encoded
 * and backslash-encoded `..` both decode to a parent-directory hop, and on
 * Windows `\` is a separator too, so normalising and then re-checking
 * containment is not optional — a hosted site would otherwise serve the user's
 * `.env`, their SSH keys, or anything else under the process's reach.
 *
 * Returns `null` for a path that escapes the root; the caller answers 403.
 */
export function resolveStaticFile(
    root: string,
    urlPath: string,
    opts: { fallbackFile?: string } = {},
): ResolvedStatic | null {
    const fallbackFile = opts.fallbackFile ?? 'index.html';
    let decoded: string;
    try {
        decoded = decodeURIComponent(urlPath.split('?')[0]?.split('#')[0] ?? '/');
    } catch {
        // A malformed escape is not a path we can reason about — refuse it
        // rather than falling back to the raw bytes.
        return null;
    }

    // Treat `\` as a separator BEFORE resolving: on Windows it already is one,
    // and on POSIX a literal `\` in a filename is not worth serving.
    const normalised = decoded.replace(/\\/g, '/');
    const rootAbs = path.resolve(root);
    const candidate = path.resolve(rootAbs, `.${normalised.startsWith('/') ? '' : '/'}${normalised}`);

    if (!isInside(rootAbs, candidate)) return null;

    const isDirLike = normalised.endsWith('/') || normalised === '';
    if (isDirLike) {
        return { filePath: path.join(candidate, 'index.html'), fallback: false };
    }
    return { filePath: candidate, fallback: false };
}

/** Containment check that does not trip on a prefix like `/root-evil`. Defined
 *  in `paths.ts` (the persisted site config needs the same check without
 *  dragging `node:http` in) and re-exported here, where it is used. */
export { isInside };

/** The SPA shell for a path that matched no file. */
export function spaFallback(root: string, fallbackFile = 'index.html'): ResolvedStatic {
    return { filePath: path.resolve(root, fallbackFile), fallback: true };
}

/** Minimal content-type table — a built frontend only emits a handful of types,
 *  and guessing wrong on `.js` breaks module loading (`text/plain` is refused). */
const CONTENT_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filePath: string): string {
    return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// --- default listener seam -------------------------------------------------

const defaultListener: HttpListener = {
    listen(handler, opts: ListenOptions): Promise<BoundServer> {
        const server = opts.tls
            ? https.createServer({ cert: opts.tls.certPem, key: opts.tls.keyPem }, handler as never)
            : http.createServer(handler as never);
        return new Promise<BoundServer>((resolve, reject) => {
            server.once('error', reject);
            server.listen(opts.port, opts.host, () => {
                const addr = server.address();
                const port = typeof addr === 'object' && addr ? addr.port : opts.port;
                resolve({
                    port,
                    close: () =>
                        new Promise<void>((done) => {
                            server.close(() => done());
                        }),
                });
            });
        });
    },
};

// --- runtime ---------------------------------------------------------------

export interface StaticRuntimeOptions {
    listener?: HttpListener;
    /**
     * Local TLS material for hosted static sites.
     *
     * Optional on purpose. The Testing Browser reaches a site through the local
     * carrier, which dials loopback and presents the browser its OWN session-CA
     * leaf (`remote/site-ca.ts`) — so the loopback hop being plain http changes
     * nothing the user sees, and it is the same shape the carrier already
     * handles for discovered http sites. Supplying material here is for the
     * case a normal browser hits the origin directly, which is P2's story once
     * there is a trusted CA to issue from.
     */
    tls?: TlsMaterial;
    readFile?: (filePath: string) => Promise<Buffer>;
}

interface Entry {
    status: HostedStatus;
    server?: BoundServer;
}

export function createStaticRuntime(opts: StaticRuntimeOptions = {}): SiteRuntime {
    const listener = opts.listener ?? defaultListener;
    const readFile = opts.readFile ?? ((p: string) => fsp.readFile(p));
    const entries = new Map<string, Entry>();
    const scheme = opts.tls ? 'https' : 'http';

    const stopped = (siteId: string): HostedStatus => ({
        siteId,
        state: 'stopped',
        backend: 'static',
        target: null,
        origin: null,
    });

    const takenPorts = (): Set<number> => {
        const taken = new Set<number>();
        for (const entry of entries.values()) {
            const port = entry.status.target?.port;
            if (port !== undefined) taken.add(port);
        }
        return taken;
    };

    /** The request handler for one site. Exported behaviour is covered by the
     *  pure helpers above; this is the thin glue that reads and writes. */
    function handlerFor(site: HostedSite) {
        return async (req: unknown, res: unknown) => {
            const request = req as http.IncomingMessage;
            const response = res as http.ServerResponse;
            const resolved = resolveStaticFile(site.root, request.url ?? '/');
            if (!resolved) {
                response.writeHead(403).end('forbidden');
                return;
            }
            try {
                const body = await readFile(resolved.filePath);
                response
                    .writeHead(200, { 'content-type': contentTypeFor(resolved.filePath) })
                    .end(body);
            } catch {
                // Not a real file → the SPA shell owns this path. 200, not 404:
                // a client-side route is a legitimate URL of this origin.
                const shell = spaFallback(site.root, site.index);
                try {
                    const body = await readFile(shell.filePath);
                    response
                        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                        .end(body);
                } catch {
                    response.writeHead(404).end('not found');
                }
            }
        };
    }

    async function start(site: HostedSite): Promise<HostedStatus> {
        const existing = entries.get(site.id);
        if (existing && existing.status.state === 'running') return existing.status;

        const port = assignPort(site.id, takenPorts());
        try {
            const server = await listener.listen(handlerFor(site), {
                port,
                // Loopback ONLY — a previewed site is never published to the LAN.
                host: '127.0.0.1',
                tls: opts.tls,
            });
            const status: HostedStatus = {
                siteId: site.id,
                state: 'running',
                backend: 'static',
                target: {
                    scheme,
                    hostname: site.hostname.toLowerCase(),
                    port: server.port,
                    loopback: '127.0.0.1',
                },
                origin: hostedOrigin(site.hostname, server.port, scheme),
            };
            entries.set(site.id, { status, server });
            return status;
        } catch (e) {
            const status: HostedStatus = {
                ...stopped(site.id),
                state: 'failed',
                error: e instanceof Error ? e.message : String(e),
            };
            entries.set(site.id, { status });
            return status;
        }
    }

    async function stop(siteId: string): Promise<void> {
        const entry = entries.get(siteId);
        if (!entry) return;
        await entry.server?.close();
        entries.delete(siteId);
    }

    return {
        backend: 'static',
        start,
        stop,
        status: (siteId) => entries.get(siteId)?.status ?? stopped(siteId),
        list: () => [...entries.values()].map((e) => e.status),
        async stopAll() {
            await Promise.all([...entries.keys()].map((id) => stop(id)));
        },
    };
}
