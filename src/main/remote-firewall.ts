/**
 * GENIE 1'S FIREWALL RULE, PORTED (v1 main/mobile/firewall.ts; Tynn #820). Unchanged but for the rule's name (below).
 */
import { spawn } from 'node:child_process';
import { resolveProgram, systemProgram } from '../core/program-lookup.js';
import type { FirewallRuleFacts, FirewallRuleView } from '../renderer/features.js';

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

/** Genie 2's own rule (Tynn #820). NOT Genie 1's "Genie Mobile": adding a rule deletes the old one BY NAME first, and
 *  Genie 1 — still installed beside Genie 2 — depends on its own. */
export const FIREWALL_RULE_NAME = 'Genie 2 remote access';

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
        `& '${systemProgram('netsh').replace(/'/g, "''")}'`,
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
        `try { $p = Start-Process -FilePath '${systemProgram('powershell').replace(/'/g, "''")}' -ArgumentList ` +
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

// --- the rule's state, read from Windows, and removing it (Tynn #685) ----------

/**
 * WHY NETSH, NOT Get-NetFirewallRule. Measured on Windows Server 2025 as a standard user (Azure 1113-181038-fdcb0b):
 * `Get-NetFirewallRule` fails with "Cannot connect to CIM server. Access denied", while `netsh advfirewall firewall show
 * rule name=…` answers without elevation. Genie runs as the person, not an Administrator, so it reads with netsh.
 */
const RULE_SEPARATOR = /^-{10,}\s*$/;
/** A `Label:  value` line: the label starts the line and holds no colon (an IPv6 value may). */
const FIELD_LINE = /^([^\s:][^:]*):(.*)$/;

/**
 * Read `netsh advfirewall firewall show rule name=…`, its stdout and exit code, into Genie's rule's state. Pure.
 *
 * netsh prints, per matching rule, a `Rule Name:` line, a line of dashes, then one `Label:  value` line per property, and
 * `Ok.` after the last rule; exit 1 with "No rules match the specified criteria." when none does (both measured, Azure
 * 1113-182502-c7d78d). A property may run onto indented lines (an ICMP rule's Type/Code table): those stay with it. Labels
 * are localized, so facts are read from English labels only and a Windows in another language reads `covers: null` with
 * every line as printed, never a guess.
 */
export function parseShowRule(stdout: string, exitCode: number, port: number): FirewallRuleView {
    const lines = stdout.split(/\r?\n/);
    const words = lines.map((l) => l.trim()).filter((l) => l !== '');
    if (exitCode !== 0) {
        if (words.length === 0) return { state: 'unknown', reason: 'netsh did not answer.' };
        if (words.some((l) => /^No rules match/i.test(l))) return { state: 'absent' };
        return { state: 'unknown', reason: words.join(' ') };
    }
    const rules: FirewallRuleFacts[] = [];
    for (let k = 0; k < lines.length; k += 1) {
        if (!RULE_SEPARATOR.test(lines[k]!)) continue;
        const fields: { label: string; value: string }[] = [];
        for (let j = k + 1; j < lines.length; j += 1) {
            const line = lines[j]!;
            // The next rule's name line (followed by its own separator) ends this rule.
            if (RULE_SEPARATOR.test(line) || RULE_SEPARATOR.test(lines[j + 1] ?? '')) break;
            const field = FIELD_LINE.exec(line);
            if (field) fields.push({ label: field[1]!.trim(), value: field[2]!.trim() });
            else if (/^\s+\S/.test(line) && fields.length > 0) {
                const last = fields[fields.length - 1]!;
                last.value = `${last.value}\n${line.trim().replace(/\s+/g, ' ')}`;
            }
        }
        rules.push(factsOf(fields));
    }
    if (rules.length === 0) return { state: 'unknown', reason: words.length ? `netsh answered without a rule: ${words.join(' ')}` : 'netsh did not answer.' };
    const each = rules.map((r) => ruleCovers(r, port));
    const covers = each.includes(true) ? true : each.includes(null) ? null : false;
    return { state: 'present', port, covers, rules };
}

function factsOf(fields: readonly { label: string; value: string }[]): FirewallRuleFacts {
    const get = (label: string): string | null => {
        const f = fields.find((x) => x.label === label);
        return f ? f.value.split('\n')[0]! : null;
    };
    const yesNo = (v: string | null, yes: string, no: readonly string[]): boolean | null => (v === yes ? true : v !== null && no.includes(v) ? false : null);
    return {
        fields,
        enabled: yesNo(get('Enabled'), 'Yes', ['No']),
        inbound: yesNo(get('Direction'), 'In', ['Out']),
        allow: yesNo(get('Action'), 'Allow', ['Block', 'Bypass']),
        protocol: get('Protocol'),
        localPort: get('LocalPort'),
        remoteIp: get('RemoteIP'),
        profiles: get('Profiles'),
    };
}

/** Whether one rule lets TCP `port` in: `false` as soon as a fact Genie can read says no, `null` if one it needs is unread. */
function ruleCovers(r: FirewallRuleFacts, port: number): boolean | null {
    if (r.enabled === false || r.inbound === false || r.allow === false) return false;
    if (r.protocol !== null && r.protocol !== 'TCP' && r.protocol !== 'Any') return false;
    if (r.localPort !== null && !portIn(r.localPort, port)) return false;
    if (r.enabled === null || r.inbound === null || r.allow === null || r.protocol === null || r.localPort === null) return null;
    return true;
}

/** `Any`, a port, a range `a-b`, or a comma list of them, as netsh prints LocalPort. */
function portIn(spec: string, port: number): boolean {
    return spec.split(',').map((s) => s.trim()).some((s) => {
        if (s === 'Any') return true;
        const range = /^(\d+)-(\d+)$/.exec(s);
        if (range) return port >= Number(range[1]) && port <= Number(range[2]);
        return /^\d+$/.test(s) && Number(s) === port;
    });
}

/**
 * Genie's rule's state, read from Windows by its exact name (netsh, no elevation). Never throws: a runner that fails reads
 * `unknown` with its words.
 */
export async function readFirewallRule(port: number, run: NetshExec = runNetsh): Promise<FirewallRuleView> {
    if (process.platform !== 'win32') return { state: 'unknown', reason: 'The firewall rule is only on Windows.' };
    try {
        assertPort(port);
        const { stdout, code } = await run(buildShowRuleArgs());
        return parseShowRule(stdout, code, port);
    } catch (e) {
        return { state: 'unknown', reason: e instanceof Error ? e.message : 'Windows Firewall could not be read.' };
    }
}

/** The ELEVATED script that removes Genie's rule: ONE netsh delete, by the exact name, and its exit code. Pure. */
export function buildRemoveInnerScript(): string {
    return [netshCmdline(buildDeleteRuleArgs()), 'exit $LASTEXITCODE'].join('\n');
}

/**
 * Remove Genie's own rule, and only it, through the same single UAC prompt Allow uses. Non-win32 → refused in words, nothing
 * run. `{ ok }`, `{ ok:false, cancelled:true }` on a declined prompt, or `{ ok:false, error }` in words. Never throws.
 */
export async function removeFirewallRule(
    run: ElevationExec = runPowershell,
): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    if (process.platform !== 'win32') return { ok: false, error: 'The firewall rule is only on Windows.' };
    let code: number;
    try {
        code = await run(buildElevationCommand(encodeCommand(buildRemoveInnerScript())));
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Windows Firewall could not be changed.' };
    }
    if (code === 0) return { ok: true };
    if (code === UAC_CANCELLED_EXIT) return { ok: false, cancelled: true };
    return { ok: false, error: `Windows Firewall did not remove the rule (netsh exit ${code}).` };
}

// --- default executors (never invoked in unit tests — injected over) ---------

/** Read rules with netsh (no elevation). Resolves stdout + exit code; any spawn
 *  failure resolves as a non-match (code 1) rather than rejecting. */
function runNetsh(args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
        try {
            const child = spawn(resolveProgram('netsh'), args, { windowsHide: true });
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
                resolveProgram('powershell.exe'),
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
