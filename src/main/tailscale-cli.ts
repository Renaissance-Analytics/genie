/**
 * GENIE 1'S TAILSCALE, PORTED (v1 main/tailscale/index.ts; Tynn #821, the owner 2026-10-19: remote connections "that
 * Genie 1 had"). Verbatim. Settings → Remote access reads its status and offers its up and install.
 */
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
    message?: string | undefined;
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
 * The installer is only ever fetched from Tailscale's own `pkgs.` host, and runs only on Windows' verdict that it is validly signed by Tailscale (genie#1497).
 *
 * Returns `{ started: true }` when the Windows installer was launched, or a `url`
 * for the caller to open instead (other platforms, or a download failure).
 */
/** Windows' verdict on a file, in its own words, and who signed it. */
export interface AuthenticodeAnswer { readonly status: string; readonly subject: string | null }

/** The publisher, read from the real installer's certificate table (2026-11-03): CN and O, both this, under DigiCert's code-signing CA. */
const TAILSCALE_PUBLISHER = 'Tailscale Inc.';

/** A certificate subject's parts by name. A value with a comma in it is quoted, so it is split outside quotes only, and a name further along cannot pass for the first. */
function subjectParts(subject: string): Map<string, string> {
    const parts = new Map<string, string>();
    for (const piece of subject.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
        const at = piece.indexOf('=');
        if (at > 0) parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim().replace(/^"(.*)"$/, '$1'));
    }
    return parts;
}

/** Why this file is not to be run, or null. Anything but Windows' own "Valid", from Tailscale, is a reason. */
export function refusalOf(answer: AuthenticodeAnswer): string | null {
    if (answer.status !== 'Valid') return `its signature is ${answer.status || 'unreadable'}`;
    const parts = subjectParts(answer.subject ?? '');
    if (parts.get('CN') === TAILSCALE_PUBLISHER && parts.get('O') === TAILSCALE_PUBLISHER) return null;
    return `it is signed by ${parts.get('CN') ?? 'nobody it could read'}, not ${TAILSCALE_PUBLISHER}`;
}

/**
 * WINDOWS' OWN CHECK: WinVerifyTrust, the documented API, reached from PowerShell 5.1 through Add-Type. Not Get-AuthenticodeSignature: on CI's Windows runner its module would not load ("the module could not be loaded"),
 * with PSModulePath removed and with the policy bypassed, so it cannot be relied on being there. An embedded signature is what is asked about, which is what Tailscale's installer carries; a catalogue is not consulted.
 * Revocation is not checked online: the check must not hang on a person's network. The script goes as -EncodedCommand and the file's name in the environment, so neither is quoted, and PowerShell by its full path.
 */
const AUTHENTICODE_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class GenieTrust {',
    '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '    struct FileInfo { public uint cbStruct; [MarshalAs(UnmanagedType.LPWStr)] public string path; public IntPtr file; public IntPtr subject; }',
    '    [StructLayout(LayoutKind.Sequential)]',
    '    struct Data { public uint cbStruct; public IntPtr policy; public IntPtr sip; public uint ui; public uint revocation; public uint union; public IntPtr file; public uint state; public IntPtr stateData; public IntPtr url; public uint flags; public uint context; public IntPtr settings; }',
    '    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]',
    '    static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref Data data);',
    '    public static int Check(string path) {',
    '        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");',
    '        var info = new FileInfo { cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo)), path = path };',
    '        var memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));',
    '        try {',
    '            Marshal.StructureToPtr(info, memory, false);',
    '            var data = new Data { cbStruct = (uint)Marshal.SizeOf(typeof(Data)), ui = 2, revocation = 0, union = 1, file = memory, state = 1 };',
    '            var result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);',
    '            data.state = 2;',
    '            WinVerifyTrust(new IntPtr(-1), ref action, ref data);',
    '            return result;',
    '        } finally { Marshal.FreeHGlobal(memory); }',
    '    }',
    '}',
    "'@",
    '$code = [GenieTrust]::Check($env:GENIE_AUTHENTICODE_FILE)',
    '$subject = $null',
    'try { $subject = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($env:GENIE_AUTHENTICODE_FILE).Subject } catch { $subject = $null }',
    "[pscustomobject]@{ code = $code; subject = $subject } | ConvertTo-Json -Compress",
].join('\n');

/** WinVerifyTrust's answers, in the words people search for. */
export function trustWords(code: number): string {
    const unsigned = code >>> 0;
    if (unsigned === 0) return 'Valid';
    if (unsigned === 0x800b0100) return 'NotSigned';
    if (unsigned === 0x80096010) return 'HashMismatch';
    if (unsigned === 0x800b0109 || unsigned === 0x800b0004 || unsigned === 0x800b0111) return 'NotTrusted';
    if (unsigned === 0x800b0101) return 'Expired';
    return `UnknownError 0x${unsigned.toString(16)}`;
}

export function readAuthenticode(file: string): Promise<AuthenticodeAnswer> {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(AUTHENTICODE_SCRIPT, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
        execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: { ...process.env, GENIE_AUTHENTICODE_FILE: file }, windowsHide: true, timeout: 60_000 }, (error, stdout) => {
            if (error) { reject(error); return; }
            try {
                const parsed = JSON.parse(String(stdout)) as { code?: unknown; subject?: unknown };
                if (typeof parsed.code !== 'number') { reject(new Error('no answer from WinVerifyTrust')); return; }
                resolve({ status: trustWords(parsed.code), subject: typeof parsed.subject === 'string' ? parsed.subject : null });
            } catch (parseError) { reject(parseError as Error); }
        });
    });
}

export interface InstallPorts {
    readonly platform: NodeJS.Platform;
    readonly installed: () => string | null;
    readonly download: (url: string) => Promise<Response>;
    readonly verify: (file: string) => Promise<AuthenticodeAnswer>;
    readonly launch: (file: string) => void;
}

export async function installTailscale(over: Partial<InstallPorts> & Pick<InstallPorts, 'download'>): Promise<{
    started: boolean;
    url?: string;
    message?: string;
}> {
    if ((over.installed ?? tailscaleCliPath)()) {
        return { started: false, message: 'Tailscale is already installed.' };
    }
    if ((over.platform ?? process.platform) !== 'win32') {
        // macOS / Linux: open the official download page; install is OS-specific.
        return { started: false, url: TAILSCALE_DOWNLOAD_PAGE };
    }
    try {
        const res = await over.download(WIN_INSTALLER_URL);
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
        const buf = Buffer.from(await res.arrayBuffer());
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tailscale-setup-'));
        const dest = path.join(folder, 'tailscale-setup.exe');
        fs.writeFileSync(dest, buf);
        // Windows' verdict before anything runs. A check that cannot run is a refusal, never a pass.
        let refusal: string | null;
        try {
            refusal = refusalOf(await (over.verify ?? readAuthenticode)(dest));
        } catch {
            refusal = 'its signature could not be checked';
        }
        if (refusal) {
            fs.rmSync(folder, { recursive: true, force: true });
            return { started: false, url: TAILSCALE_DOWNLOAD_PAGE, message: `The Tailscale installer was not run: ${refusal}.` };
        }
        // Launch detached so Tailscale's installer outlives this call; the user
        // drives its UI. Not windowsHide — the user needs to see the installer.
        if (over.launch) { over.launch(dest); return { started: true }; }
        const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
        child.unref();
        return { started: true };
    } catch (e) {
        // Network / write failure → fall back to the download page so the user
        // can still get Tailscale.
        return { started: false, url: WIN_INSTALLER_URL, message: (e as Error).message };
    }
}
