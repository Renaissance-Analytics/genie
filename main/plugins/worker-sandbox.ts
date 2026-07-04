/**
 * Plugin WORKER sandbox policy (Plugin System, Phase 3 — §5.2 / §7.2a).
 *
 * PURE policy data + helpers shared by the worker bootstrap (embedded into the
 * `utilityProcess` entry) and its unit tests, so the lockdown rules are a SINGLE
 * source of truth and independently testable without spinning up Electron.
 *
 * Two controls live here:
 *
 *   1. **Module denylist** — a plugin worker is a Node process, so by default it
 *      could `require('fs')`/`require('child_process')` and reach ambient
 *      authority the capability bridge is meant to mediate. {@link DENIED_BUILTINS}
 *      is the set of Node built-ins with ambient FS / NETWORK / PROCESS / native
 *      power; the worker installs a `Module._load` guard that throws on any of
 *      them. The generators (dark-slide / holy-sheet) are pure in-memory byte
 *      APIs (verified: they import NO node built-ins), so this costs them nothing
 *      — their ONLY path to disk is the mediated bridge.
 *
 *   2. **Env minimisation** — the host must NOT hand the plugin its full
 *      `process.env` (which carries GitHub tokens, signing secrets, Reverb keys,
 *      …). {@link buildMinimalEnv} keeps only an allowlist of resolution/locale
 *      vars and drops anything secret-shaped.
 *
 * NOTE (honest residual): the guard covers CommonJS `require` (and static
 * `import`, which compiles to `require` in the CJS worker). A deliberately
 * malicious `import('node:fs')` (dynamic ESM) resolves through the ESM loader,
 * NOT `Module._load`, so it is not caught in-process. The robust closure is
 * Node's Permission Model (`--permission --allow-fs-read=<dirs>`), which must be
 * validated under Electron's utilityProcess in a real build before it is turned
 * on (see worker-host `NODE_PERMISSION_EXECARGV`). Until then the ENFORCED layers
 * are: OS-process isolation, this require-guard, the minimised env (no secrets to
 * exfiltrate), the mediated fs/net bridge, and the signature/trust gate that
 * keeps untrusted code from running at all.
 */

/**
 * Node built-in ROOTS a plugin worker may NOT require. Subpaths collapse to their
 * root (`fs/promises`→`fs`, `dns/promises`→`dns`, `inspector/promises`→`inspector`),
 * so the roots cover the whole family.
 *   - FS:        fs
 *   - NETWORK:   net, http, https, http2, dns, dgram, tls
 *   - PROCESS:   child_process, cluster, worker_threads
 *   - RCE/DEBUG: vm, repl, inspector, v8, wasi, module
 *   - INFO LEAK: os (hostname / username / network interfaces), trace_events
 */
export const DENIED_BUILTINS: string[] = [
    'fs',
    'net',
    'http',
    'https',
    'http2',
    'dns',
    'dgram',
    'tls',
    'child_process',
    'cluster',
    'worker_threads',
    'vm',
    'repl',
    'inspector',
    'v8',
    'wasi',
    'module',
    'os',
    'trace_events',
];

/** Normalise a require request to its built-in root (strips `node:` + subpath). */
export function builtinRoot(request: string): string {
    let r = String(request);
    if (r.startsWith('node:')) r = r.slice(5);
    return r.split('/')[0];
}

/** True when a require request targets a denied built-in (fail-closed). */
export function isRequestDenied(request: string): boolean {
    return DENIED_BUILTINS.includes(builtinRoot(request));
}

/**
 * The ONLY environment variables forwarded to a plugin worker (compared
 * case-insensitively). Just enough for module resolution + locale; deliberately
 * NO user-identity (HOME/USERPROFILE/APPDATA), NO Genie internals (GENIE_MCP_URL,
 * GENIE_TERMINAL_ID), and NO secrets. `GENIE_PLUGIN_NODE_PATH` is added
 * explicitly by the host as the resolution fallback (not from the real env).
 */
export const ENV_ALLOWLIST: string[] = [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'NODE_ENV',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
];

/** Secret-shaped env keys — dropped even if somehow allowlisted (belt + braces). */
const SECRET_KEY_RE =
    /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|session|cookie|_key$|github|gh_|aws|gcp|azure|openai|anthropic|reverb|npm_)/i;

/** True when an env key looks like it carries a secret. */
export function isSecretEnvKey(key: string): boolean {
    return SECRET_KEY_RE.test(key);
}

/**
 * Build the minimal, secret-free env for a plugin worker from the host's full
 * env, plus any explicit `extra` (e.g. `GENIE_PLUGIN_NODE_PATH`). Only
 * allowlisted, non-secret keys survive.
 */
export function buildMinimalEnv(
    fullEnv: NodeJS.ProcessEnv,
    extra: Record<string, string> = {},
): Record<string, string> {
    const allow = new Set(ENV_ALLOWLIST.map((k) => k.toLowerCase()));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fullEnv)) {
        if (typeof v !== 'string') continue;
        if (!allow.has(k.toLowerCase())) continue;
        if (isSecretEnvKey(k)) continue;
        out[k] = v;
    }
    for (const [k, v] of Object.entries(extra)) {
        if (typeof v === 'string') out[k] = v;
    }
    return out;
}
