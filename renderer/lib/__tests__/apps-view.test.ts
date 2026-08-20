import { describe, expect, it } from 'vitest';
import {
    appSummaryLine,
    permissionSummary,
    reachLabel,
    uninstallConfirmation,
    requirementLine,
    missingRuntimesNote,
} from '../apps-view';
import type { InstalledAppView, AppRequirementView } from '../genie';

/**
 * What the Apps panel SAYS about an installed Genie App.
 *
 * Pure, because the renderer has no DOM harness and because these sentences are
 * the whole security UX: a user who cannot tell at a glance what an app was
 * allowed to do has not really consented to anything. The panel renders these
 * strings; it does not compose its own.
 */

const app = (over: Partial<InstalledAppView> = {}): InstalledAppView => ({
    id: 'com.example.trader',
    name: 'Example Trader',
    slug: 'trader',
    version: '1.0.0',
    workspaceId: 'ws-app',
    installPath: 'C:/apps/trader.agi',
    scope: 'self',
    workspaces: [],
    revoked: false,
    devMode: false,
    homeUrl: 'https://trader.gen/',
    installedAt: '2026-01-01T00:00:00.000Z',
    permissions: [
        {
            key: 'hosting',
            label: 'Host sites and services',
            grantDescription: '…',
            risk: 'standard',
            granted: true,
        },
        {
            key: 'terminals',
            label: 'Run commands',
            grantDescription: '…',
            risk: 'high',
            granted: false,
        },
    ],
    ...over,
});

describe('the collapsed row', () => {
    it('says the version and where the app lives', () => {
        const line = appSummaryLine(app());
        expect(line).toContain('v1.0.0');
        expect(line).toContain('trader.gen');
    });

    it('leads with REVOKED when it is, because nothing else matters then', () => {
        // A revoked app looks identical to a working one in every other respect.
        // If the row does not say so, the user's next stop is a bug report.
        expect(appSummaryLine(app({ revoked: true }))).toMatch(/^Turned off/);
    });
});

describe('what it was allowed to do', () => {
    it('counts the granted against the asked-for', () => {
        expect(permissionSummary(app())).toBe('1 of 2 permissions granted');
    });

    it('says plainly when an app can do nothing', () => {
        // "0 of 2" is arithmetic. "Cannot call Genie" is the fact.
        const none = app({ permissions: app().permissions.map((p) => ({ ...p, granted: false })) });
        expect(permissionSummary(none)).toMatch(/cannot call Genie/i);
    });

    it('says so when an app never asked for anything', () => {
        expect(permissionSummary(app({ permissions: [] }))).toMatch(/asked for no permissions/i);
    });

    it('names a HIGH-risk permission it holds, rather than hiding it in a count', () => {
        // "3 of 4 granted" reads the same whether the third is "Open files for
        // you" or "Run any command on this machine". Say which.
        const dangerous = app({
            permissions: app().permissions.map((p) => ({ ...p, granted: true })),
        });
        expect(permissionSummary(dangerous)).toContain('Run commands');
    });
});

describe('how far it can reach', () => {
    it('describes its own workspace as the narrow case', () => {
        expect(reachLabel('self', [])).toMatch(/own workspace/i);
    });

    it('counts a named allow-list', () => {
        expect(reachLabel('workspaces', ['a', 'b'])).toContain('2');
    });

    it('does not soften workstation reach', () => {
        // This is the widest thing a user can grant. The label should read like
        // it, not like another option in a list.
        expect(reachLabel('workstation', [])).toMatch(/every workspace/i);
    });
});

describe('uninstalling', () => {
    it('says what goes AND what stays', () => {
        // Uninstall removes the grant, not the files. A confirmation that implied
        // otherwise would be asking the user to agree to something untrue.
        const text = uninstallConfirmation(app());
        expect(text).toContain('Example Trader');
        expect(text).toMatch(/permission/i);
        expect(text).toMatch(/files|workspace/i);
        expect(text).toContain('trader.agi');
    });
});

describe('what the app still needs from this machine', () => {
    const req = (over: Partial<AppRequirementView> = {}): AppRequirementView => ({
        tool: 'rust',
        reason: 'compiles the engine',
        status: 'user-provides',
        ...over,
    });

    it('names the tool AND why the app wants it', () => {
        // "Install rust" is an instruction. "Install rust — it compiles the
        // engine" is a decision the user can make.
        const line = requirementLine(req());
        expect(line).toContain('rust');
        expect(line).toContain('compiles the engine');
    });

    it('includes the version when the app pinned one', () => {
        expect(requirementLine(req({ version: '1.84' }))).toContain('1.84');
    });

    it('survives a requirement with no reason given', () => {
        expect(() => requirementLine(req({ reason: undefined }))).not.toThrow();
        expect(requirementLine(req({ reason: undefined }))).toContain('rust');
    });

    it('says nothing at all when the machine has everything', () => {
        expect(missingRuntimesNote([])).toBeNull();
    });

    it('says how many are missing, so an unstartable service is EXPLAINED', () => {
        // Without this the user sees a backend that never comes up and concludes
        // the app — or Genie — is broken.
        const note = missingRuntimesNote([req(), req({ tool: 'docker', reason: 'sandboxes it' })]);
        expect(note).toContain('2');
        expect(note).toMatch(/install/i);
    });
});

describe('an app you are BUILDING', () => {
    it('says so in the row, since it runs from a folder Genie does not control', () => {
        // Dev apps get dev tools and live in the developer's own directory. That is
        // a different trust posture from an installed app, and the list is where
        // someone would notice one they forgot about.
        expect(appSummaryLine(app({ devMode: true }))).toMatch(/development/i);
        expect(appSummaryLine(app())).not.toMatch(/development/i);
    });

    it('still leads with turned-off when it is BOTH', () => {
        // Revoked is the fact that changes what every other line means.
        expect(appSummaryLine(app({ devMode: true, revoked: true }))).toMatch(/^Turned off/);
    });
});
