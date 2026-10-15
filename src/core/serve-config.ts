import { isAbsolute, normalize, posix, sep } from 'node:path';

/**
 * HOSTED `.gen` SITES (§6.6) — the pure half.
 *
 * **Agents never write a web-server config.** The owner's screenshot that earned this rule was an
 * agent hand-rolling an nginx `server {}` block inline, because Genie had no first-class "serve
 * this directory". Genie owns the config; this file renders it.
 *
 * Three serve MODES, the split every local-hosting tool makes (Herd/Valet, DDEV, Lando):
 *
 * - **proxy** — the repo's own dev server, or any port. Node, Go, Python, Ruby ARE their own web
 *   server; they are proxied. No generated config.
 * - **static** — a built directory, `spa` adding the `index.html` fallback.
 * - **php** — `public/` behind a FastCGI worker. PHP is the one mainstream language that is not
 *   its own web server; that is PHP's nature, not Genie's complexity, and it is the floor Herd
 *   itself pays (nginx + php-fpm). `php-cgi` is the portable worker (Windows has no fpm).
 *
 * Every rendered site binds **loopback only**; the `.gen` front door is a separate router.
 */

export interface RepoFacts {
    /** Repo-relative paths, forward slashes, of the files that matter for detection. */
    readonly files: readonly string[];
    readonly packageScripts: Readonly<Record<string, string>>;
}

export type Stack = 'laravel' | 'node' | 'django' | 'go';

export interface DevServer {
    readonly stack: Stack;
    /** `{port}` is substituted with the allocated loopback port at start. */
    readonly command: string;
}

/** The dev server a repo runs, from what is on disk. `null` when nothing is recognised. */
export function detectDevServer(facts: RepoFacts): DevServer | null {
    const has = (f: string) => facts.files.includes(f);
    if (has('artisan')) return { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' };
    if (has('package.json')) {
        const script = ['dev', 'start', 'serve'].find((s) => s in facts.packageScripts);
        if (script) return { stack: 'node', command: `npm run ${script} -- --port {port}` };
    }
    if (has('manage.py')) return { stack: 'django', command: 'python manage.py runserver 127.0.0.1:{port}' };
    if (has('go.mod') && facts.files.some((f) => f.endsWith('.go') && !f.includes('/'))) return { stack: 'go', command: 'go run .' };
    return null;
}

export type ServeSpec =
    | { readonly mode: 'proxy' }
    | { readonly mode: 'static'; readonly root: string; readonly spa: boolean }
    | { readonly mode: 'php'; readonly root: string; readonly fcgiPort: number };

const BUILT_DIRS = ['dist', 'build', 'out'];

/**
 * A built directory a repo could serve static, when it has NO dev server of its own.
 * Conservative: a repo you develop is left to its dev command, and a bare root `index.html` is
 * not a site.
 */
export function detectStaticServe(facts: RepoFacts): ServeSpec | null {
    if (detectDevServer(facts) !== null) return null;
    for (const dir of BUILT_DIRS) {
        if (facts.files.includes(`${dir}/index.html`)) return { mode: 'static', root: dir, spa: true };
    }
    return null;
}

export interface CaddyfileInput {
    readonly sitePort: number;
    /** Absolute path of the repo. Required for static and php. */
    readonly repoPath?: string;
    readonly serve: ServeSpec;
}

/** `root` must be a relative path that stays inside the repo. */
function rootInside(repoPath: string, root: string): string {
    if (isAbsolute(root) || /^[A-Za-z]:/.test(root)) throw new Error(`serve root ${root} must be inside the repo (a relative path)`);
    const rel = normalize(root).split(sep).join('/');
    if (rel === '..' || rel.startsWith('../') || rel.includes('/../')) throw new Error(`serve root ${root} escapes the repo; it must be inside the repo`);
    return posix.join(repoPath.split(sep).join('/'), rel);
}

/**
 * The per-site Caddyfile, or `null` for proxy mode (nothing to render). Loopback bind, always, and ONLY its own port:
 * `auto_https off` (else Caddy opens a redirect server on 0.0.0.0:80), `admin off` (else every site's Caddy wants
 * 127.0.0.1:2019, which the front door holds), and an explicit `http://` address (else a host-qualified address is
 * served over HTTPS, while the front door proxies in plain HTTP). Measured on the owner's machine, 2026-10-14: one
 * site's Caddy held :80 and :2019, so the other sites and the front door could not start.
 *
 * The address names NO host (`http://:<port>`) and `bind 127.0.0.1` keeps it on loopback. A host in the address is a
 * Host MATCHER: `http://127.0.0.1:<port>` answered only requests whose Host was `127.0.0.1`, and the front door forwards
 * the site's own name (`Host: accepta.gen`, which apps need to build their URLs) — so every static and PHP site answered
 * the front door with Caddy's empty 200 (measured in the Windows test VM, 2026-10-14).
 */
export function serveCaddyfile(input: CaddyfileInput): string | null {
    const { serve } = input;
    if (serve.mode === 'proxy') return null;
    if (!input.repoPath) throw new Error('a static or php site needs the repo path');
    const root = rootInside(input.repoPath, serve.root);
    const lines = ['{', '\tauto_https off', '\tadmin off', '}', '', `http://:${input.sitePort} {`, '\tbind 127.0.0.1', `\troot * ${root}`];
    if (serve.mode === 'static') {
        if (serve.spa) lines.push('\ttry_files {path} /index.html');
        lines.push('\tfile_server');
    } else {
        lines.push(`\tphp_fastcgi 127.0.0.1:${serve.fcgiPort}`, '\tfile_server');
    }
    lines.push('}', '');
    return lines.join('\n');
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The site's `.gen` host. One DNS label, lower-cased; anything else is refused. */
export function genHost(name: string): string {
    const label = name.toLowerCase();
    if (!LABEL.test(label)) throw new Error(`${JSON.stringify(name)} is not a valid site name (one hostname label: a-z, 0-9, hyphens inside)`);
    return `${label}.gen`;
}
