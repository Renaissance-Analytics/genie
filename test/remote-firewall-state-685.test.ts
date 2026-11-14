import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemProgram } from '../src/core/program-lookup.js';
import {
    FIREWALL_RULE_NAME,
    UAC_CANCELLED_EXIT,
    buildRemoveInnerScript,
    parseShowRule,
    readFirewallRule,
    removeFirewallRule,
} from '../src/main/remote-firewall.js';

/**
 * READING GENIE'S FIREWALL RULE FROM WINDOWS, AND REMOVING IT (Tynn #685).
 *
 * MEASURED on Windows Server 2025 as a standard user (Azure 1113-181038-fdcb0b): `Get-NetFirewallRule` fails ("Cannot
 * connect to CIM server. Access denied"), while `netsh advfirewall firewall show rule name=…` answers. So the rule is read
 * with netsh, which needs no elevation, and parsed here.
 *
 * The fixtures are netsh's own bytes (Azure 1113-182502-c7d78d, code page 437, CRLF): built-in rules, since adding a rule
 * needs an Administrator the job is not. `genieRule` is the RDP rule's real bytes with the values Genie's own `add` sets.
 * netsh prints one block per matching rule; `twoRules` joins two real blocks as netsh does when a name matches more than
 * one (that case was not captured).
 */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/netsh-show-rule/${name}`, import.meta.url), 'latin1');
const rdp = fixture('rdp-tcp-in.exit0.txt');
const echoDisabled = fixture('echo-icmpv4-disabled.exit0.txt');
const llmnrDisabled = fixture('llmnr-udp-disabled.exit0.txt');
const noMatch = fixture('no-match.exit1.txt');
const genieRule = rdp
    .replace('Remote Desktop - User Mode (TCP-In)', FIREWALL_RULE_NAME)
    .replace(/(Grouping:\s+)Remote Desktop/, '$1')
    .replace(/(RemoteIP:\s+)Any/, '$1100.64.0.0/255.192.0.0')
    .replace(/(LocalPort:\s+)3389/, '$17421');
const block = (s: string): string => s.replace(/Ok\.\r\n\r\n$/, '');
const twoRules = block(genieRule) + block(genieRule.replace(/(LocalPort:\s+)7421/, '$17422')) + 'Ok.\r\n\r\n';

const ORIGINAL_PLATFORM = process.platform;
beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }));
afterEach(() => Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true }));

describe('parseShowRule — netsh’s real output', () => {
    it('CONTROL on the fixture: the substitution took (Genie’s values are in it, RDP’s are not)', () => {
        expect(genieRule).toContain(`Rule Name:                            ${FIREWALL_RULE_NAME}\r\n`);
        expect(genieRule).toMatch(/LocalPort:\s+7421\r\n/);
        expect(genieRule).not.toContain('3389');
    });

    it('Genie’s rule, letting 7421 in: present, covers the port, with what Windows reports', () => {
        const v = parseShowRule(genieRule, 0, 7421);
        expect(v).toMatchObject({ state: 'present', port: 7421, covers: true });
        if (v.state !== 'present') throw new Error('not present');
        expect(v.rules).toHaveLength(1);
        expect(v.rules[0]).toMatchObject({ enabled: true, inbound: true, allow: true, protocol: 'TCP', localPort: '7421', remoteIp: '100.64.0.0/255.192.0.0', profiles: 'Domain,Private,Public' });
        // Every line Windows printed, in its words, in its order (Rule Name and the rule's own separator are not facts).
        expect(v.rules[0]!.fields.map((f) => f.label)).toEqual(['Enabled', 'Direction', 'Profiles', 'Grouping', 'LocalIP', 'RemoteIP', 'Protocol', 'LocalPort', 'RemotePort', 'Edge traversal', 'Action']);
    });

    it('a rule for another port: present, and does NOT cover the port remote access uses', () => {
        expect(parseShowRule(rdp, 0, 7421)).toMatchObject({ state: 'present', covers: false });
        expect(parseShowRule(rdp, 0, 3389)).toMatchObject({ state: 'present', covers: true });
    });

    it('a disabled rule: present, enabled false, does not cover its own port', () => {
        const v = parseShowRule(llmnrDisabled, 0, 5355);
        expect(v).toMatchObject({ state: 'present', covers: false });
        if (v.state !== 'present') throw new Error('not present');
        expect(v.rules[0]).toMatchObject({ enabled: false, protocol: 'UDP', localPort: '5355', remoteIp: 'LocalSubnet' });
    });

    it('continuation lines (an ICMP rule’s Type/Code table) are kept with their field, never read as fields', () => {
        const v = parseShowRule(echoDisabled, 0, 7421);
        if (v.state !== 'present') throw new Error('not present');
        expect(v.rules[0]!.fields.map((f) => f.label)).toEqual(['Enabled', 'Direction', 'Profiles', 'Grouping', 'LocalIP', 'RemoteIP', 'Protocol', 'Edge traversal', 'Action']);
        expect(v.rules[0]!.protocol).toBe('ICMPv4');
        expect(v.rules[0]!.localPort).toBeNull();
    });

    it('two rules by that name: both read; covered if either lets the port in', () => {
        const v = parseShowRule(twoRules, 0, 7422);
        if (v.state !== 'present') throw new Error('not present');
        expect(v.rules.map((r) => r.localPort)).toEqual(['7421', '7422']);
        expect(v.covers).toBe(true);
    });

    it('"No rules match the specified criteria." (exit 1): absent', () => {
        expect(parseShowRule(noMatch, 1, 7421)).toEqual({ state: 'absent' });
    });

    it('nothing at all (netsh never ran): unknown, saying so', () => {
        expect(parseShowRule('', 1, 7421)).toEqual({ state: 'unknown', reason: 'netsh did not answer.' });
    });

    it('any other failure: unknown, in netsh’s own words', () => {
        expect(parseShowRule('\r\nThe RPC server is unavailable.\r\n\r\n', 1, 7421)).toEqual({ state: 'unknown', reason: 'The RPC server is unavailable.' });
    });

    it('exit 0 with no rule block in it: unknown, never "present"', () => {
        expect(parseShowRule('\r\nOk.\r\n\r\n', 0, 7421)).toMatchObject({ state: 'unknown' });
    });

    it('a Windows in another language: present with its lines as printed, and covers unknown (null), never guessed', () => {
        const de = genieRule.replace('Rule Name:', 'Regelname:').replace('Enabled:', 'Aktiviert:').replace(': Yes', ': Ja')
            .replace('LocalPort:', 'Lokaler Port:').replace('Action:', 'Aktion:').replace('Direction:', 'Richtung:');
        const v = parseShowRule(de, 0, 7421);
        expect(v).toMatchObject({ state: 'present', covers: null });
        if (v.state !== 'present') throw new Error('not present');
        expect(v.rules[0]!.fields.some((f) => f.label === 'Lokaler Port' && f.value === '7421')).toBe(true);
        expect(v.rules[0]!.enabled).toBeNull();
    });
});

describe('readFirewallRule — the exact netsh command, no elevation', () => {
    it('asks netsh for Genie’s rule BY ITS EXACT NAME, and parses what it says', async () => {
        const asked: string[][] = [];
        const v = await readFirewallRule(7421, async (args) => { asked.push(args); return { stdout: genieRule, code: 0 }; });
        expect(asked).toEqual([['advfirewall', 'firewall', 'show', 'rule', 'name=Genie 2 remote access']]);
        expect(v).toMatchObject({ state: 'present', covers: true });
    });

    it('no rule: absent', async () => {
        expect(await readFirewallRule(7421, async () => ({ stdout: noMatch, code: 1 }))).toEqual({ state: 'absent' });
    });

    it('a throwing runner: unknown, in words, never a throw', async () => {
        expect(await readFirewallRule(7421, async () => { throw new Error('spawn netsh ENOENT'); })).toEqual({ state: 'unknown', reason: 'spawn netsh ENOENT' });
    });
});

describe('removeFirewallRule — deletes ONLY Genie’s rule, by its exact name, through the same elevation Allow uses', () => {
    const decodeInner = (outer: string): string => {
        const b64 = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)?.[1];
        if (!b64) throw new Error(`no encoded command in: ${outer}`);
        return Buffer.from(b64, 'base64').toString('utf16le');
    };

    it('the elevated script is exactly: netsh delete rule name="Genie 2 remote access", then its exit code', () => {
        expect(buildRemoveInnerScript()).toBe(
            `& '${systemProgram('netsh')}' advfirewall firewall delete rule name="Genie 2 remote access"\nexit $LASTEXITCODE`,
        );
    });

    it('runs it elevated (Start-Process -Verb RunAs, one UAC prompt), and the command carries that script and nothing else', async () => {
        const ran: string[] = [];
        const r = await removeFirewallRule(async (cmd) => { ran.push(cmd); return 0; });
        expect(r).toEqual({ ok: true });
        expect(ran).toHaveLength(1);
        expect(ran[0]).toContain('-Verb RunAs');
        expect(decodeInner(ran[0]!)).toBe(buildRemoveInnerScript());
        // ONLY Genie's rule: nothing that adds, and no other name.
        expect(decodeInner(ran[0]!)).not.toMatch(/\badd\b/);
        expect(decodeInner(ran[0]!).match(/name=/g)).toHaveLength(1);
    });

    it('declined at the Windows prompt: cancelled', async () => {
        expect(await removeFirewallRule(async () => UAC_CANCELLED_EXIT)).toEqual({ ok: false, cancelled: true });
    });

    it('netsh failed: says so in words, with its exit code', async () => {
        expect(await removeFirewallRule(async () => 1)).toEqual({ ok: false, error: 'Windows Firewall did not remove the rule (netsh exit 1).' });
    });

    it('CONTROL: not Windows: refuses in words, runs nothing', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        let ran = false;
        const r = await removeFirewallRule(async () => { ran = true; return 0; });
        expect(ran).toBe(false);
        expect(r).toEqual({ ok: false, error: 'The firewall rule is only on Windows.' });
    });
});
