import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMPTY_HOST_SUMMARY, hostSummaryOf, readHostSummary } from '../src/core/host-summary.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-3a (Tynn #898, story #954; part of #913; the coordinator's split, 2026-11-20). main read
 * genie-host's relay host through its engine replica for two synchronous answers: this machine's Pilot/Drone role (every
 * outward dial and WebSocket a window opens is refused for a drone) and the Tynn account a relay window was opened under.
 * Both now ride the summary genie-host already pushes main (summary.watch): `workstationRole` and `tynnAccountKey`. main's
 * relay-host onChange, refresh and reads go; only the one-shot registration with Genie 1's identity stays until 2g-3b,
 * which hands that identity over with the legacy secrets. main's pushFeatures (its window's own facts) is no longer said
 * on an account change: genie-host's features follow its own accounts.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

describe('the summary carries the role and the Tynn account', () => {
    it('as genie-host reads them; with none said, a drone signed out (fail closed)', () => {
        expect(hostSummaryOf([], [], [], { workstationRole: 'pilot', tynnAccountKey: 'https://tynn.ai#m@example.com' })).toMatchObject({ workstationRole: 'pilot', tynnAccountKey: 'https://tynn.ai#m@example.com' });
        expect(EMPTY_HOST_SUMMARY).toMatchObject({ workstationRole: 'drone', tynnAccountKey: null });
    });

    it('read from the wire: Tynn’s role or none; anything else, or a host that says nothing, is a drone', () => {
        const base = { terminals: [], armedFlows: [], scheduledTasks: [], processes: [], services: [], sites: [] };
        expect(readHostSummary({ ...base, workstationRole: 'pilot', tynnAccountKey: 'k' })).toMatchObject({ workstationRole: 'pilot', tynnAccountKey: 'k' });
        expect(readHostSummary({ ...base, workstationRole: null, tynnAccountKey: null })).toMatchObject({ workstationRole: null, tynnAccountKey: null });
        expect(readHostSummary({ ...base, workstationRole: 'admin', tynnAccountKey: 7 })).toMatchObject({ workstationRole: 'drone', tynnAccountKey: null });
        expect(readHostSummary(base)).toMatchObject({ workstationRole: 'drone', tynnAccountKey: null });
    });
});

describe('genie-host says them, as its relay host and its Tynn account change', () => {
    const host = code(src('src/main/genie-host.ts'));
    it('read from its relay host and its account; poked on each of their changes', () => {
        // ...and, since Tynn #959 (2g-3b), whether its keychain can keep secrets and GitHub's block (split-2g3b-adopt-legacy.test.ts).
        expect(host).toMatch(/read: \(\) => hostSummaryOf\(terminalHost\.list\(\), hostFlows\.list\(\), hostBook\.kept\(\), \{ workstationRole: relayHostService\.role\(\), tynnAccountKey: tynnAccountNow \? accountKeyOf\(tynnAccountNow\.status\(\)\) : null, keychainReady: /);
        expect(host).toMatch(/onChange: \(\) => \{ featureChanged\(\); pokeSummary\(\); \}/);
        expect(host).toMatch(/account\.onChange\(pokeSummary\)/);
    });
});

describe('main reads the role and the account from the summary', () => {
    const main = code(src('src/main/main.ts'));
    it('the dial refusals and the WebSocket gate read the summary’s role; a relay window’s account is the summary’s', () => {
        expect(main).not.toMatch(/workstationRoleNow/);
        expect((main.match(/outboundDialRefusal\(hostSummaryNow\.workstationRole, /g) ?? []).length).toBe(3);
        expect(main).toMatch(/const tynnAccountKeyNow = \(\): string \| null => hostSummaryNow\.tynnAccountKey;/);
    });

    it('a change of account closes the relay windows opened under the last one, heard from the summary', () => {
        expect(main).toMatch(/if \(summary\.tynnAccountKey !== hostSummaryNow\.tynnAccountKey\) \{ hostSummaryNow = summary; closeRelayWindowsOfOtherAccounts\(\); \}/);
        expect(main).not.toMatch(/tynnAccount\.onChange\(\(\) => \{ closeRelayWindowsOfOtherAccounts\(\); \}\)/);
    });

    it('main holds no relay replica: Genie 1’s identity travels with the legacy secrets and genie-host registers itself (2g-3b, Tynn #959)', () => {
        expect(main).not.toMatch(/linkedRelayHost/);
        expect(src('test/split-2e-window-guard.test.ts')).not.toMatch(/relayHost: '2g'/);
    });

    it('no account change says the window’s own facts again (pushFeatures is the window’s pane and notice only)', () => {
        expect(main).not.toMatch(/afterTynnUrl/);
        expect(main).not.toMatch(/githubAccount\.onChange\(\(\) => \{ pushFeatures\(\);/);
        expect(main).not.toMatch(/keyring\?\.onChange\(\(\) => \{\s*pushFeatures\(\);/);
        expect(main).not.toMatch(/startSignIn\(\)\.then\(\(\) => \{ pushFeatures\(\); \}/);
        expect(main).not.toMatch(/registering = null; pushFeatures\(\);/);
    });
});
