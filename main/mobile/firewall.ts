import { spawn } from 'node:child_process';

/**
 * Windows Firewall rule management for the Mobile server port.
 *
 * The mobile server binds to the SPECIFIC Tailscale IP (never 0.0.0.0 / loopback),
 * and Windows denies inbound by default — so without an explicit inbound allow
 * rule a paired phone's SYN to http://<tailnet-ip>:<port>/m/ is silently dropped
 * ("can't connect"). The NSIS installer rule (build/installer.nsh) only lands in an
 * ELEVATED / perMachine install; Genie ships as a per-user (no-UAC) install, so the
 * reliable out-of-box fix is adding the rule at RUNTIME via a single UAC prompt
 * when the user clicks "Allow through Windows Firewall".
 *
 * The rule is scoped TIGHTLY to the Tailscale CGNAT range (100.64.0.0/10) so only
 * tailnet peers can reach the port — matching Genie's bind-to-tailnet model.
 *
 * The whole module no-ops on non-win32. The pure builders + parsers are exported
 * for unit tests; the actual netsh/UAC execution (injected `run` fns) is
 * manual-verify-only (a subprocess + an OS elevation prompt can't run in CI).
 */

/** The single, stable rule name — MUST match build/installer.nsh so the two paths
 *  manage the exact same rule (and uninstall cleans up whichever added it). */
export const FIREWALL_RULE_NAME = 'Genie Mobile';

/** Tailscale CGNAT range — the rule is scoped to tailnet peers only. */
export const TAILNET_CIDR = '100.64.0.0/10';

/** Exit code the elevation script uses when the UAC prompt is DECLINED (ERROR_
 *  CANCELLED), so the caller can say "cancelled" rather than "failed". */
export const UAC_CANCELLED_EXIT = 1223;

/**
 * Reject anything that isn't a usable TCP port BEFORE it is ever interpolated into
 * a command string — defence-in-depth against command injection (the value only
 * ever reaches netsh as a validated integer).
 */
function assertPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid firewall port: ${String(port)}`);
    }
}

/** netsh arg array to ADD the inbound tailnet-scoped allow rule for `port`. */
export function buildAddRuleArgs(port: number): string[] {
    assertPort(port);
    return [
        'advfirewall',
        'firewall',
        'add',
        'rule',
        `name=${FIREWALL_RULE_NAME}`,
        'dir=in',
        'action=allow',
        'protocol=TCP',
        `localport=${port}`,
        `remoteip=${TAILNET_CIDR}`,
        'profile=any',
    ];
}

/** netsh arg array to DELETE the rule (by name). */
export function buildDeleteRuleArgs(): string[] {
    return ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE_NAME}`];
}

/** netsh arg array to SHOW the rule (standard-user readable — for the existence
 *  check; reading rules needs no elevation). */
export function buildShowRuleArgs(): string[] {
    return ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`];
}

/**
 * Decide, from a `netsh ... show rule name="Genie Mobile"` result, whether OUR
 * rule exists AND is scoped to `port`. Pure → unit-tested. netsh prints the rule
 * block + exit 0 when found, or "No rules match…" + exit 1 when not. A rule for a
 * DIFFERENT (old) port reads as MISSING here — the new port isn't in the output —
 * so a port change re-adds/migrates. We match the numeric port rather than a
 * localized "LocalPort:" label so this survives non-English Windows.
 */
export function ruleMatchesPort(stdout: string, exitCode: number, port: number): boolean {
    if (exitCode !== 0) return false;
    return new RegExp(`\\b${port}\\b`).test(stdout);
}

/** A netsh subprocess result, surfaced to the pure logic (injectable for tests). */
export interface ExecResult {
    stdout: string;
    code: number;
}
export type NetshExec = (args: string[]) => Promise<ExecResult>;
/** Runs the elevation script and resolves its exit code (injectable for tests). */
export type ElevationExec = (script: string) => Promise<number>;

/**
 * Whether OUR firewall rule already covers `port`. Non-win32 → false (not
 * applicable). Any error → false (offer the fix rather than hide a possibly-missing
 * rule). `run` is injectable; the default reads rules via netsh (no elevation).
 */
export async function firewallRuleExists(
    port: number,
    run: NetshExec = runNetsh,
): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
        assertPort(port);
        const { stdout, code } = await run(buildShowRuleArgs());
        return ruleMatchesPort(stdout, code, port);
    } catch {
        return false;
    }
}

/** Render a netsh arg array as a command-line string, double-quoting the `name=`
 *  value (it contains a space). Used only inside the base64-encoded elevated
 *  script, so the embedded quotes never cross a shell boundary unescaped. */
function netshCmdline(args: string[]): string {
    return [
        'netsh',
        ...args.map((a) => (a.startsWith('name=') ? `name="${FIREWALL_RULE_NAME}"` : a)),
    ].join(' ');
}

/**
 * The ELEVATED inner script: delete any stale rule (idempotent + migrates a changed
 * port) then add the current one; the add's exit code becomes the process exit.
 * Pure so the shape is unit-tested. netsh is a native exe, so a non-zero `delete`
 * (rule absent) doesn't throw — both run, and `exit $LASTEXITCODE` reports the add.
 */
export function buildInnerFirewallScript(port: number): string {
    assertPort(port);
    return [
        netshCmdline(buildDeleteRuleArgs()),
        netshCmdline(buildAddRuleArgs(port)),
        'exit $LASTEXITCODE',
    ].join('\n');
}

/**
 * The OUTER (non-elevated) orchestration command: elevate ONE hidden PowerShell
 * (a SINGLE UAC prompt) running the base64 delete+add script; `-Wait -PassThru`
 * yields its exit code. A DECLINED UAC prompt makes Start-Process throw → we exit
 * UAC_CANCELLED_EXIT so the caller reports "cancelled" rather than "failed". Single
 * line, single-quotes only (no double-quotes) so it survives being passed as one
 * argv to `powershell -Command`. Pure → unit-tested.
 */
export function buildElevationCommand(encodedCommand: string): string {
    return (
        `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ` +
        `'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encodedCommand}' ` +
        `-Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit ${UAC_CANCELLED_EXIT} }`
    );
}

/** Map the elevation script's exit code to a result. Pure → unit-tested. */
export function interpretElevationExit(code: number): {
    ok: boolean;
    cancelled?: boolean;
    error?: string;
} {
    if (code === 0) return { ok: true };
    if (code === UAC_CANCELLED_EXIT) return { ok: false, cancelled: true };
    return { ok: false, error: `Windows Firewall update failed (exit ${code}).` };
}

/** Base64 (UTF-16LE) encode a script for `powershell -EncodedCommand`. */
function encodeCommand(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Add (idempotently) the tailnet-scoped inbound rule for `port` via a SINGLE UAC
 * prompt. Non-win32 → no-op. `run` is injectable; the default spawns the outer
 * PowerShell. Returns `{ ok }`, `{ ok:false, cancelled:true }` on a declined UAC
 * prompt, or `{ ok:false, error }` otherwise — never throws.
 */
export async function ensureFirewallRule(
    port: number,
    run: ElevationExec = runPowershell,
): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'The firewall rule is only needed on Windows.' };
    }
    let code: number;
    try {
        assertPort(port);
        const encoded = encodeCommand(buildInnerFirewallScript(port));
        code = await run(buildElevationCommand(encoded));
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Firewall update failed.' };
    }
    return interpretElevationExit(code);
}

// --- default executors (never invoked in unit tests — injected over) ---------

/** Read rules with netsh (no elevation). Resolves stdout + exit code; any spawn
 *  failure resolves as a non-match (code 1) rather than rejecting. */
function runNetsh(args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
        try {
            const child = spawn('netsh', args, { windowsHide: true });
            let stdout = '';
            child.stdout?.on('data', (d: Buffer) => {
                stdout += d.toString();
            });
            child.on('error', () => resolve({ stdout: '', code: 1 }));
            child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
        } catch {
            resolve({ stdout: '', code: 1 });
        }
    });
}

/** Run the outer orchestration script; resolves the exit code (the elevated inner
 *  add's code, or UAC_CANCELLED_EXIT on a declined prompt). */
function runPowershell(script: string): Promise<number> {
    return new Promise((resolve) => {
        try {
            const child = spawn(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
                { windowsHide: true },
            );
            child.on('error', () => resolve(1));
            child.on('close', (code) => resolve(code ?? 1));
        } catch {
            resolve(1);
        }
    });
}
