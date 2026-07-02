import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FIREWALL_RULE_NAME,
    TAILNET_CIDR,
    UAC_CANCELLED_EXIT,
    buildAddRuleArgs,
    buildDeleteRuleArgs,
    buildShowRuleArgs,
    buildElevationCommand,
    buildInnerFirewallScript,
    ensureFirewallRule,
    firewallRuleExists,
    interpretElevationExit,
    ruleMatchesPort,
} from '../firewall';

/**
 * Covers the PURE builders/parsers + the injected-exec wiring of the mobile
 * firewall helper. The real netsh subprocess + UAC elevation are runtime-only
 * (manual-verify): every test injects a fake exec so no admin prompt / process is
 * spawned. The win32-guarded functions (firewallRuleExists / ensureFirewallRule)
 * are pinned to platform 'win32' per-block via withWin32() so their guarded logic
 * runs on ANY runner — the local sandbox is Windows but CI is Linux.
 */

const ORIGINAL_PLATFORM = process.platform;

/** Pin process.platform to 'win32' for the enclosing describe so the win32-guarded
 *  firewall paths execute regardless of the host OS (restored after each test). */
function withWin32(): void {
    beforeEach(() =>
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }),
    );
    afterEach(() =>
        Object.defineProperty(process, 'platform', {
            value: ORIGINAL_PLATFORM,
            configurable: true,
        }),
    );
}

describe('buildAddRuleArgs', () => {
    it('builds the tailnet-scoped inbound TCP allow rule for the port', () => {
        expect(buildAddRuleArgs(51718)).toEqual([
            'advfirewall',
            'firewall',
            'add',
            'rule',
            `name=${FIREWALL_RULE_NAME}`,
            'dir=in',
            'action=allow',
            'protocol=TCP',
            'localport=51718',
            `remoteip=${TAILNET_CIDR}`,
            'profile=any',
        ]);
    });

    it('uses the ACTUAL port (not a hardcoded 51718)', () => {
        expect(buildAddRuleArgs(52000)).toContain('localport=52000');
    });

    it('rejects a non-integer / out-of-range port (no command injection)', () => {
        expect(() => buildAddRuleArgs(0)).toThrow();
        expect(() => buildAddRuleArgs(-1)).toThrow();
        expect(() => buildAddRuleArgs(70000)).toThrow();
        expect(() => buildAddRuleArgs(51718.5)).toThrow();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => buildAddRuleArgs('51718; rm -rf' as any)).toThrow();
    });
});

describe('buildDeleteRuleArgs / buildShowRuleArgs', () => {
    it('delete targets the rule by name', () => {
        expect(buildDeleteRuleArgs()).toEqual([
            'advfirewall',
            'firewall',
            'delete',
            'rule',
            `name=${FIREWALL_RULE_NAME}`,
        ]);
    });
    it('show targets the rule by name', () => {
        expect(buildShowRuleArgs()).toEqual([
            'advfirewall',
            'firewall',
            'show',
            'rule',
            `name=${FIREWALL_RULE_NAME}`,
        ]);
    });
});

describe('ruleMatchesPort', () => {
    const found = `
Rule Name:                            Genie Mobile
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Protocol:                             TCP
LocalPort:                            51718
RemoteIP:                             100.64.0.0/10
`;
    it('true only when found (exit 0) AND the port appears', () => {
        expect(ruleMatchesPort(found, 0, 51718)).toBe(true);
    });
    it('false when the rule is for a DIFFERENT port (→ re-add/migrate)', () => {
        expect(ruleMatchesPort(found, 0, 52000)).toBe(false);
    });
    it('false when netsh reports no match (exit 1)', () => {
        expect(ruleMatchesPort('No rules match the specified criteria.', 1, 51718)).toBe(false);
    });
});

describe('firewallRuleExists (injected netsh exec)', () => {
    withWin32();
    it('true when the show output matches the port', async () => {
        const run = vi.fn().mockResolvedValue({ stdout: 'LocalPort: 51718', code: 0 });
        expect(await firewallRuleExists(51718, run)).toBe(true);
        expect(run).toHaveBeenCalledWith(buildShowRuleArgs());
    });
    it('false when the rule exists but for a different port', async () => {
        const run = vi.fn().mockResolvedValue({ stdout: 'LocalPort: 51718', code: 0 });
        expect(await firewallRuleExists(52000, run)).toBe(false);
    });
    it('false when netsh returns "no match"', async () => {
        const run = vi.fn().mockResolvedValue({ stdout: 'No rules match', code: 1 });
        expect(await firewallRuleExists(51718, run)).toBe(false);
    });
    it('false (never throws) when the exec rejects', async () => {
        const run = vi.fn().mockRejectedValue(new Error('spawn failed'));
        expect(await firewallRuleExists(51718, run)).toBe(false);
    });
});

describe('buildInnerFirewallScript (elevated delete-then-add)', () => {
    it('deletes then adds, quotes the rule name, carries the port + CIDR + exit', () => {
        const s = buildInnerFirewallScript(51718);
        const del = s.indexOf('delete rule name="Genie Mobile"');
        const add = s.indexOf('add rule name="Genie Mobile"');
        expect(del).toBeGreaterThanOrEqual(0);
        expect(add).toBeGreaterThan(del); // delete BEFORE add (idempotent)
        expect(s).toContain('localport=51718');
        expect(s).toContain('remoteip=100.64.0.0/10');
        expect(s).toContain('exit $LASTEXITCODE');
    });
});

describe('buildElevationCommand (single UAC prompt)', () => {
    it('elevates one hidden powershell with the encoded script + maps a decline', () => {
        const cmd = buildElevationCommand('QkFTRTY0');
        expect(cmd).toContain('Start-Process');
        expect(cmd).toContain('-Verb RunAs');
        expect(cmd).toContain('-EncodedCommand');
        expect(cmd).toContain('QkFTRTY0');
        expect(cmd).toContain('-Wait');
        expect(cmd).toContain('-PassThru');
        expect(cmd).toContain('exit $p.ExitCode');
        expect(cmd).toContain(`exit ${UAC_CANCELLED_EXIT}`); // declined UAC → cancelled
        // No double-quotes — survives being passed as one argv to -Command.
        expect(cmd).not.toContain('"');
    });
});

describe('interpretElevationExit', () => {
    it('0 → ok', () => {
        expect(interpretElevationExit(0)).toEqual({ ok: true });
    });
    it('1223 → cancelled (declined UAC), not an error', () => {
        expect(interpretElevationExit(UAC_CANCELLED_EXIT)).toEqual({ ok: false, cancelled: true });
    });
    it('other → error', () => {
        const r = interpretElevationExit(1);
        expect(r.ok).toBe(false);
        expect(r.cancelled).toBeUndefined();
        expect(r.error).toContain('exit 1');
    });
});

describe('ensureFirewallRule (injected elevation exec)', () => {
    withWin32();
    it('maps a 0 exit to ok and feeds the exec an elevation command with our port', async () => {
        const run = vi.fn().mockResolvedValue(0);
        expect(await ensureFirewallRule(51718, run)).toEqual({ ok: true });
        const script = run.mock.calls[0][0] as string;
        expect(script).toContain('Start-Process');
        expect(script).toContain('-EncodedCommand');
    });
    it('maps a declined UAC (1223) to cancelled', async () => {
        const run = vi.fn().mockResolvedValue(UAC_CANCELLED_EXIT);
        expect(await ensureFirewallRule(51718, run)).toEqual({ ok: false, cancelled: true });
    });
    it('maps any other non-zero exit to an error', async () => {
        const run = vi.fn().mockResolvedValue(5);
        const r = await ensureFirewallRule(51718, run);
        expect(r.ok).toBe(false);
        expect(r.error).toContain('exit 5');
    });
    it('rejects an invalid port before ever invoking the exec', async () => {
        const run = vi.fn().mockResolvedValue(0);
        const r = await ensureFirewallRule(0, run);
        expect(r.ok).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });
});
