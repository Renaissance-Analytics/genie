import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pexecFile = promisify(execFile);

/**
 * Tailscale lifecycle management — Work Mode (host ⇄ remote desktop) needs Genie
 * to MANAGE Tailscale, not just detect the tailnet IP (see ./mobile/tailnet.ts,
 * which is detection-only). This module shells out to the `tailscale` CLI to read
 * status and bring the node online, so the Work Mode settings can surface the
 * tailnet + reachable peers and a one-click "connect" without a separate app.
 *
 * Everything platform- or output-dependent is a PURE function — the JSON mapping
 * (`parseTailscaleStatus`), the CLI lookup (`resolveTailscaleCliPath`), the
 * failure classifier (`classifyTailscaleFailure`) and the remedy text
 * (`tailscaleRemedy`) — so Linux behaviour is unit-tested from any dev box and
 * the CLI-invoking wrappers stay thin.
 */

export interface TailnetPeer {
    hostname: string;
    ip: string | null;
    online: boolean;
    os: string;
    /** MagicDNS name (trailing dot stripped) — the address a peer's Tailscale
     *  TLS certificate covers, so it's the DIAL address for an HTTPS host. */
    dnsName: string | null;
}

/**
 * What Genie could establish about Tailscale on this machine. These are five
 * DIFFERENT situations with five different remedies; before genie#380/#396 the
 * first four all rendered as "Installed · offline" and offered an Install button
 * that fixes only one of them.
 *
 *  - `absent`         — no `tailscale` binary. Install it.
 *  - `stopped`        — the CLI is here, the local `tailscaled` daemon is not
 *                       reachable. On Arch `pacman -S tailscale` does NOT enable
 *                       the unit, so this is the normal post-install state.
 *  - `needs-operator` — the daemon is up but this user may not drive it.
 *  - `needs-login`    — daemon reachable and permitted, node not up. "Bring
 *                       online" is the remedy (it may hand back a login URL).
 *  - `running`        — BackendState === 'Running'.
 *  - `unknown`        — the CLI failed in a way we do not recognise. We say so
 *                       and surface the raw error rather than guess a remedy.
 */
export type TailscaleState =
    | 'absent'
    | 'stopped'
    | 'needs-operator'
    | 'needs-login'
    | 'running'
    | 'unknown';

/** What to tell the user, and the exact command that fixes it (when there is one). */
export interface TailscaleRemedy {
    message: string;
    /** A shell command the user can run verbatim. Absent when none applies. */
    command?: string;
}

export interface TailscaleStatus {
    /** The `tailscale` CLI was found on this machine. Derived from `state`. */
    installed: boolean;
    /** BackendState === 'Running' — the node is up + authenticated. */
    running: boolean;
    /** The specific state, so the UI stops collapsing four of them into "offline". */
    state: TailscaleState;
    /** This node's tailnet identity (null before the first `up`). */
    self: { ip: string | null; hostname: string; online: boolean; dnsName: string | null } | null;
    peers: TailnetPeer[];
    /** A login URL Tailscale surfaces when the node needs interactive auth. */
    authUrl?: string | null;
    /** How to get out of `state`; null when nothing is wrong (or nothing is known). */
    remedy?: TailscaleRemedy | null;
}

/** First IPv4 in a TailscaleIPs[] (the list also carries the IPv6 ULA). */
function firstV4(ips?: string[]): string | null {
    return (ips ?? []).find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? null;
}

/** `DNSName` as the status JSON reports it ends with a dot — strip it. */
function stripDnsDot(name?: string): string | null {
    const n = (name ?? '').replace(/\.$/, '');
    return n || null;
}

/**
 * Directories a Linux Tailscale lands in, for the case where Genie's inherited
 * PATH is not the user's shell PATH (a GUI/AppImage launch usually isn't).
 */
const LINUX_TAILSCALE_DIRS = [
    '/usr/bin',
    '/usr/local/bin',
    '/usr/sbin',
    '/opt/tailscale/bin',
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
];

/**
 * PURE: resolve the `tailscale` CLI for `platform`, or null when it is not
 * installed. Fed the filesystem predicate and `PATH` so every platform's branch
 * is unit-tested from any dev box.
 *
 * genie#380: Linux used to return the bare string `'tailscale'` with NO check,
 * so `installed` was never established there — it was assumed, and the caller's
 * `installed: false` branch was dead code. Linux now looks the binary up on
 * PATH and then along {@link LINUX_TAILSCALE_DIRS}, exactly as the other two
 * platforms already checked their candidates.
 */
export function resolveTailscaleCliPath(
    platform: NodeJS.Platform,
    exists: (p: string) => boolean,
    pathEnv: string | undefined,
): string | null {
    if (platform === 'win32') {
        const p = 'C:\\Program Files\\Tailscale\\tailscale.exe';
        return exists(p) ? p : null;
    }
    if (platform === 'darwin') {
        const candidates = [
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
            '/usr/local/bin/tailscale',
            '/opt/homebrew/bin/tailscale',
        ];
        return candidates.find((c) => exists(c)) ?? null;
    }
    // POSIX PATH separator — NOT path.delimiter, which is ';' when these tests
    // (or a cross-platform caller) run on Windows.
    const fromPath = (pathEnv ?? '')
        .split(':')
        .map((dir) => dir.trim().replace(/\/+$/, ''))
        .filter(Boolean);
    for (const dir of [...fromPath, ...LINUX_TAILSCALE_DIRS]) {
        const candidate = `${dir}/tailscale`;
        if (exists(candidate)) return candidate;
    }
    return null;
}

/** Resolve the `tailscale` CLI path for this machine, or null when not installed. */
export function tailscaleCliPath(): string | null {
    return resolveTailscaleCliPath(process.platform, fs.existsSync, process.env.PATH);
}

/** The error shape `child_process` rejects with (plus whatever the CLI printed). */
export interface TailscaleCliFailure {
    /** 'ENOENT' / 'EACCES' for a spawn failure; the exit code for a run failure. */
    code?: string | number;
    stdout?: string;
    stderr?: string;
    message?: string;
}

/** A Tailscale login URL anywhere in the CLI's output. */
const AUTH_URL = /(https:\/\/login\.tailscale\.com\/[^\s]+)/;

/**
 * PURE: what does this failed `tailscale` invocation mean?
 *
 * The matchers below are Tailscale's ACTUAL messages, not invented ones:
 *   - `cmd/tailscale/cli/diag.go` prints the "failed to connect to local
 *     tailscaled; it doesn't appear to be running (sudo systemctl start
 *     tailscaled ?)" family, and a distinct "(which appears to be running as …)"
 *     variant for a daemon that IS up but whose socket refused us.
 *   - `client/local/local.go` prefixes a denial with `Access denied: `, and
 *     `cmd/tailscale/cli/cli.go` appends "To not require root, use 'sudo
 *     tailscale set --operator=$USER' once."
 *
 * Anything unmatched is 'unknown' — the caller then surfaces the raw error
 * rather than naming a remedy that may not apply.
 */
export function classifyTailscaleFailure(
    f: TailscaleCliFailure,
): Exclude<TailscaleState, 'running'> {
    const text = `${f.stdout ?? ''}\n${f.stderr ?? ''}\n${f.message ?? ''}`;

    // The binary is gone (or unusable). NEVER read this as "installed, offline".
    if (typeof f.code === 'string' && ['ENOENT', 'EACCES', 'ENOTDIR'].includes(f.code)) {
        return 'absent';
    }
    if (/\b(ENOENT|ENOTDIR)\b/.test(text)) return 'absent';

    // Interactive auth — the one case the old code handled.
    if (AUTH_URL.test(text) || /to authenticate, visit/i.test(text)) return 'needs-login';

    // Denied by the daemon: not root, not an operator. Checked BEFORE the
    // connect-failure family because diag.go's "appears to be running as …,
    // pid …" wrapper carries both.
    if (
        /access denied/i.test(text) ||
        /--operator=/.test(text) ||
        /operator access/i.test(text) ||
        /permission denied/i.test(text) ||
        /(must be run as|requires) root/i.test(text)
    ) {
        return 'needs-operator';
    }

    // The daemon isn't there to talk to.
    if (
        /failed to connect to (the )?local (tailscaled|tailscale)/i.test(text) ||
        /doesn't appear to be running/i.test(text) ||
        /is (the )?tailscale(d)? (service |daemon )?running\?/i.test(text)
    ) {
        return 'stopped';
    }

    return 'unknown';
}

/**
 * PURE: the one-line explanation + the exact command that clears `state` on
 * `platform`. Null when there is nothing to fix, or nothing we can name.
 *
 * We never guess a package manager — an install is the download page / the
 * Install button, not a `pacman`/`apt` line we cannot know is right.
 */
export function tailscaleRemedy(
    state: TailscaleState,
    platform: NodeJS.Platform,
): TailscaleRemedy | null {
    switch (state) {
        case 'absent':
            return { message: 'Tailscale is not installed on this machine.' };
        case 'stopped':
            if (platform === 'linux') {
                return {
                    message:
                        'Tailscale is installed, but the tailscaled service is not running. ' +
                        'Installing the package does not enable the unit.',
                    command: 'sudo systemctl enable --now tailscaled',
                };
            }
            if (platform === 'darwin') {
                return { message: 'Tailscale is installed but not running — open the Tailscale app.' };
            }
            return {
                message:
                    'Tailscale is installed but the Tailscale service is not running — ' +
                    'start Tailscale, then refresh.',
            };
        case 'needs-operator':
            if (platform === 'win32') {
                return {
                    message:
                        'Tailscale refused this account. Bring the node online from the Tailscale ' +
                        'app (or run Genie as an administrator), then refresh.',
                };
            }
            return {
                message: 'Tailscale will not take commands from this user yet — grant it once.',
                command: 'sudo tailscale set --operator=$USER',
            };
        case 'needs-login':
            return { message: 'Tailscale needs you to log in.' };
        default:
            // 'running' — nothing wrong. 'unknown' — we do not know, so we do
            // not invent a remedy; the caller surfaces the raw error instead.
            return null;
    }
}

/**
 * Map `tailscale status --json` to Genie's shape. PURE — fed a JSON string,
 * never touches the CLI — so the field mapping is unit-tested directly. The CLI
 * JSON exposes `BackendState`, `Self`, `Peer{}` (keyed by node key), each with
 * `TailscaleIPs[]` (IPv4 first), `HostName`, `Online`, `OS`. Malformed input maps
 * to a safe "not running, no peers" result rather than throwing.
 */
export function parseTailscaleStatus(
    json: string,
): Omit<TailscaleStatus, 'installed' | 'state' | 'remedy'> {
    let data: {
        BackendState?: string;
        AuthURL?: string;
        Self?: { TailscaleIPs?: string[]; HostName?: string; Online?: boolean; DNSName?: string };
        Peer?: Record<
            string,
            { TailscaleIPs?: string[]; HostName?: string; Online?: boolean; OS?: string; DNSName?: string }
        >;
    };
    try {
        data = JSON.parse(json);
    } catch {
        return { running: false, self: null, peers: [] };
    }

    const self = data.Self
        ? {
              ip: firstV4(data.Self.TailscaleIPs),
              hostname: data.Self.HostName ?? '',
              online: !!data.Self.Online,
              dnsName: stripDnsDot(data.Self.DNSName),
          }
        : null;

    const peers: TailnetPeer[] = Object.values(data.Peer ?? {}).map((p) => ({
        hostname: p.HostName ?? '',
        ip: firstV4(p.TailscaleIPs),
        online: !!p.Online,
        os: p.OS ?? '',
        dnsName: stripDnsDot(p.DNSName),
    }));

    return {
        running: data.BackendState === 'Running',
        self,
        peers,
        authUrl: data.AuthURL ?? null,
    };
}

/**
 * Seams for the two CLI wrappers below, so their Linux behaviour is testable
 * without a Linux box (or a real tailnet). Defaults are the real thing.
 */
export interface TailscaleCliDeps {
    /** Where the CLI is; null = not installed. */
    cliPath?: () => string | null;
    /** Runs the CLI; rejects with a {@link TailscaleCliFailure}-shaped error. */
    run?: (
        cli: string,
        args: string[],
        timeoutMs: number,
    ) => Promise<{ stdout: string; stderr: string }>;
    /** The platform whose remedies apply. */
    platform?: NodeJS.Platform;
}

function runCli(
    cli: string,
    args: string[],
    timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
    return pexecFile(cli, args, { windowsHide: true, timeout: timeoutMs });
}

const EMPTY = { self: null, peers: [] as TailnetPeer[] };

/** Is this stdout the status document, rather than noise printed alongside an
 *  error? The "parse the stdout of a non-zero exit" path is only valid for the
 *  former — otherwise a denial with a line on stdout would outrank what its
 *  stderr plainly says. */
function looksLikeStatusJson(stdout: string): boolean {
    try {
        const v = JSON.parse(stdout);
        return !!v && typeof v === 'object';
    } catch {
        return false;
    }
}

/** Build a status from a state alone (no tailnet data to report). */
function statusFor(state: TailscaleState, platform: NodeJS.Platform): TailscaleStatus {
    return {
        installed: state !== 'absent',
        running: state === 'running',
        state,
        ...EMPTY,
        remedy: tailscaleRemedy(state, platform),
    };
}

/**
 * Read the tailnet status. Distinguishes absent / stopped / needs-operator /
 * needs-login / running (genie#380, genie#396) — `installed` is ESTABLISHED from
 * the resolved binary and the failure code, never assumed.
 */
export async function getTailscaleStatus(deps: TailscaleCliDeps = {}): Promise<TailscaleStatus> {
    const platform = deps.platform ?? process.platform;
    const cli = (deps.cliPath ?? tailscaleCliPath)();
    if (!cli) return statusFor('absent', platform);
    const run = deps.run ?? runCli;
    try {
        const { stdout } = await run(cli, ['status', '--json'], 8000);
        const parsed = parseTailscaleStatus(stdout);
        const state: TailscaleState = parsed.running ? 'running' : 'needs-login';
        return {
            installed: true,
            state,
            ...parsed,
            remedy: tailscaleRemedy(state, platform),
        };
    } catch (e) {
        const err = e as TailscaleCliFailure;
        // `tailscale status` exits non-zero when the node is stopped / needs
        // login but still prints the JSON on stdout — parse that before giving
        // up: the daemon answered, so this is not a daemon problem.
        if (err?.stdout && looksLikeStatusJson(err.stdout)) {
            const parsed = parseTailscaleStatus(err.stdout);
            const state: TailscaleState = parsed.running ? 'running' : 'needs-login';
            return {
                installed: true,
                state,
                ...parsed,
                remedy: tailscaleRemedy(state, platform),
            };
        }
        return statusFor(classifyTailscaleFailure(err ?? {}), platform);
    }
}

export interface TailscaleUpResult {
    ok: boolean;
    /** Present when Tailscale wants an interactive login. */
    authUrl?: string | null;
    message?: string;
    /** What blocked the bring-online, so the UI offers the RIGHT affordance. */
    state?: TailscaleState;
    /** The exact command that clears `state`, when there is one. */
    command?: string;
}

/**
 * Bring this node online (`tailscale up`).
 *
 * genie#396: this used to recognise exactly ONE failure — an auth URL — and
 * return a truncated raw error for everything else, which is what both standard
 * Linux failures hit (a `tailscaled` that was never enabled, and a user who is
 * not a Tailscale operator). Neither ever produces a login URL. Each failure is
 * now classified and answered with the command that fixes it; an unrecognised
 * failure still hands back the raw error rather than a guess.
 */
export async function tailscaleUp(deps: TailscaleCliDeps = {}): Promise<TailscaleUpResult> {
    const platform = deps.platform ?? process.platform;
    const cli = (deps.cliPath ?? tailscaleCliPath)();
    if (!cli) {
        const remedy = tailscaleRemedy('absent', platform);
        return { ok: false, state: 'absent', message: remedy?.message };
    }
    const run = deps.run ?? runCli;
    try {
        await run(cli, ['up'], 30000);
        return { ok: true, state: 'running' };
    } catch (e) {
        const err = e as TailscaleCliFailure;
        const out = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}\n${err?.message ?? ''}`;
        const state = classifyTailscaleFailure(err ?? {});
        if (state === 'needs-login') {
            const url = AUTH_URL.exec(out)?.[1] ?? null;
            return {
                ok: false,
                state,
                authUrl: url,
                message: url
                    ? 'Tailscale needs you to log in.'
                    : (tailscaleRemedy(state, platform)?.message ?? 'Tailscale needs you to log in.'),
            };
        }
        const remedy = tailscaleRemedy(state, platform);
        if (remedy) {
            return {
                ok: false,
                state,
                message: remedy.command
                    ? `${remedy.message} Run: ${remedy.command}`
                    : remedy.message,
                ...(remedy.command ? { command: remedy.command } : {}),
            };
        }
        // Unrecognised — surface the real error rather than invent a cause.
        return {
            ok: false,
            state,
            message: (err?.message ?? 'tailscale up failed').slice(0, 300),
        };
    }
}

const TAILSCALE_DOWNLOAD_PAGE = 'https://tailscale.com/download';
const WIN_INSTALLER_URL = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe';

/**
 * Install Tailscale so Work Mode has a tailnet to run over. On Windows, download
 * Tailscale's official signed installer and launch it (the user clicks through
 * Tailscale's own UI). On macOS/Linux the install path differs (App Store /
 * package manager), so hand back the download-page URL for the caller to open.
 * The signed installer is only ever fetched from Tailscale's own `pkgs.` host.
 *
 * Returns `{ started: true }` when the Windows installer was launched, or a `url`
 * for the caller to open instead (other platforms, or a download failure).
 */
export async function installTailscale(): Promise<{
    started: boolean;
    url?: string;
    message?: string;
}> {
    if (tailscaleCliPath()) {
        return { started: false, message: 'Tailscale is already installed.' };
    }
    if (process.platform !== 'win32') {
        // macOS / Linux: open the official download page; install is OS-specific.
        return { started: false, url: TAILSCALE_DOWNLOAD_PAGE };
    }
    try {
        const res = await fetch(WIN_INSTALLER_URL);
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
        const buf = Buffer.from(await res.arrayBuffer());
        const dest = path.join(os.tmpdir(), `tailscale-setup-${Date.now()}.exe`);
        fs.writeFileSync(dest, buf);
        // Launch detached so Tailscale's installer outlives this call; the user
        // drives its UI. Not windowsHide — the user needs to see the installer.
        const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
        child.unref();
        return { started: true };
    } catch (e) {
        // Network / write failure → fall back to the download page so the user
        // can still get Tailscale.
        return { started: false, url: WIN_INSTALLER_URL, message: (e as Error).message };
    }
}
