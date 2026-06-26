import { describe, expect, it } from 'vitest';
import {
    aggregatePermissions,
    buildFeatureManager,
    computeCapabilityStatus,
    satisfies,
    type CapabilityKey,
    type GrantedPermissions,
    type InstallationGrant,
} from '../capabilities';

/**
 * Pure capability-computation + fancy-features gate tests. No network / no
 * Electron — these exercise the logic that turns "what the App granted" into
 * "which features Genie can use", plus the pre-strategy that gates a feature
 * off when its required permission is missing.
 */

describe('aggregatePermissions', () => {
    it('folds installations to the HIGHEST access level per permission', () => {
        const granted = aggregatePermissions([
            { issues: 'read', contents: 'read' },
            { issues: 'write', metadata: 'read' },
        ]);
        // contents stays read (only granted read anywhere); issues escalates to
        // write (the higher of the two installs).
        expect(granted).toEqual({
            issues: 'write',
            contents: 'read',
            metadata: 'read',
        });
    });

    it('ignores permissions Genie does not model and bad access strings', () => {
        const granted = aggregatePermissions([
            { issues: 'read', deployments: 'write', pages: 'admin' },
            { pull_requests: 'bogus' as unknown as string },
        ]);
        // Only modelled permissions with a valid access level survive.
        expect(granted).toEqual({ issues: 'read' });
    });

    it('returns {} for no installations / empty maps', () => {
        expect(aggregatePermissions([])).toEqual({});
        expect(aggregatePermissions([{}])).toEqual({});
    });
});

describe('satisfies (access-level comparison)', () => {
    it('true only when granted access meets or exceeds the required level', () => {
        expect(satisfies({ contents: 'write' }, { permission: 'contents', access: 'write' })).toBe(true);
        expect(satisfies({ contents: 'admin' }, { permission: 'contents', access: 'write' })).toBe(true);
        // read < write — a read grant does NOT satisfy a write requirement.
        expect(satisfies({ contents: 'read' }, { permission: 'contents', access: 'write' })).toBe(false);
        // missing entirely.
        expect(satisfies({}, { permission: 'issues', access: 'read' })).toBe(false);
    });
});

describe('computeCapabilityStatus', () => {
    it('marks a capability satisfied when its permission is granted', () => {
        const granted: GrantedPermissions = {
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
            // contents / code+secret scanning NOT granted — those should be missing.
        };
        const status = computeCapabilityStatus(granted);
        expect(status.satisfied).toEqual(
            expect.arrayContaining([
                'issue-watch.issues',
                'issue-watch.pulls',
                'issue-watch.dependabot',
            ]),
        );
        // The genie-ide App declares neither code/secret scanning nor contents,
        // so those three capabilities resolve as missing.
        expect(status.missing).toEqual([
            'issue-watch.code-scanning',
            'issue-watch.secret-scanning',
            'github.provision',
        ]);
        expect(status.missingPermissions).toEqual([
            'security_events',
            'secret_scanning_alerts',
            'contents',
        ]);
    });

    it('mirrors the genie-ide reality: issues/pulls/dependabot granted, scanning + contents missing', () => {
        // The genie-ide App grants issues/pull_requests/metadata/
        // vulnerability_alerts/administration but NOT code/secret scanning or
        // contents — so those three capabilities are the missing ones.
        const granted = aggregatePermissions([
            {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                administration: 'write',
            },
        ]);
        const status = computeCapabilityStatus(granted);
        expect(status.missing).toEqual([
            'issue-watch.code-scanning',
            'issue-watch.secret-scanning',
            'github.provision',
        ]);
        // issues + pulls + dependabot satisfied.
        expect(status.satisfied).toHaveLength(3);
    });

    it('everything missing when the App granted nothing', () => {
        const status = computeCapabilityStatus({});
        expect(status.satisfied).toEqual([]);
        expect(status.missing).toEqual([
            'issue-watch.issues',
            'issue-watch.pulls',
            'issue-watch.dependabot',
            'issue-watch.code-scanning',
            'issue-watch.secret-scanning',
            'github.provision',
        ]);
        // missingPermissions is the DISTINCT set (no duplicates).
        expect(status.missingPermissions).toEqual([
            'issues',
            'pull_requests',
            'vulnerability_alerts',
            'security_events',
            'secret_scanning_alerts',
            'contents',
        ]);
    });

    it('everything satisfied when every permission is granted at sufficient access', () => {
        const status = computeCapabilityStatus({
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
            security_events: 'read',
            secret_scanning_alerts: 'read',
            contents: 'write',
        });
        expect(status.missing).toEqual([]);
        expect(status.missingPermissions).toEqual([]);
    });

    it('missingByPermission is empty when no installations are supplied', () => {
        // The aggregate alone can't attribute a gap to a specific install.
        const status = computeCapabilityStatus({
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
            security_events: 'read',
            secret_scanning_alerts: 'read',
            // contents missing — but with no installs we can't say WHICH.
        });
        expect(status.missingPermissions).toEqual(['contents']);
        expect(status.missingByPermission).toEqual([]);
    });
});

describe('computeCapabilityStatus — per-installation attribution', () => {
    const personal: InstallationGrant = {
        login: 'wishborn',
        id: 1,
        installationId: 1001,
        isOrg: false,
        // Grants everything EXCEPT contents.
        permissions: {
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
            security_events: 'read',
            secret_scanning_alerts: 'read',
        },
    };
    const orgGrants: InstallationGrant = {
        login: 'Renaissance-Analytics',
        id: 2,
        installationId: 2002,
        isOrg: true,
        // This org install DOES grant contents:write — the aggregate is satisfied.
        permissions: {
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
            security_events: 'read',
            secret_scanning_alerts: 'read',
            contents: 'write',
        },
    };

    it('lists only the installs NOT granting a missing permission', () => {
        // Aggregate across both: org grants contents:write, so the aggregate
        // SATISFIES github.provision → contents isn't missing in aggregate.
        const granted = aggregatePermissions([
            personal.permissions,
            orgGrants.permissions,
        ]);
        const status = computeCapabilityStatus(granted, [personal, orgGrants]);
        // contents satisfied in aggregate → nothing missing at all.
        expect(status.missing).toEqual([]);
        expect(status.missingByPermission).toEqual([]);
    });

    it('attributes a genuinely-missing permission to the non-granting installs', () => {
        // NEITHER install grants contents → provisioning is missing, and BOTH
        // installs are listed for `contents` (each needs its own approval).
        const personalNoContents = personal;
        const orgNoContents: InstallationGrant = {
            ...orgGrants,
            permissions: {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                // contents NOT granted here either.
            },
        };
        const installs = [personalNoContents, orgNoContents];
        const granted = aggregatePermissions(installs.map((i) => i.permissions));
        const status = computeCapabilityStatus(granted, installs);

        expect(status.missing).toEqual(['github.provision']);
        expect(status.missingPermissions).toEqual(['contents']);
        expect(status.missingByPermission).toHaveLength(1);
        const group = status.missingByPermission[0];
        expect(group.permission).toBe('contents');
        expect(group.access).toBe('write');
        expect(group.installations.map((i) => i.login)).toEqual([
            'wishborn',
            'Renaissance-Analytics',
        ]);
        // Identity (incl. installationId, used for the review URL) rides through.
        expect(group.installations[1]).toMatchObject({
            login: 'Renaissance-Analytics',
            installationId: 2002,
            isOrg: true,
        });
    });

    it('an install granting only READ is still missing a WRITE requirement', () => {
        // contents:read does NOT satisfy contents:write (provisioning needs write).
        const readOnly: InstallationGrant = {
            login: 'wishborn',
            id: 1,
            installationId: 1001,
            isOrg: false,
            permissions: {
                metadata: 'read',
                issues: 'read',
                pull_requests: 'read',
                vulnerability_alerts: 'read',
                security_events: 'read',
                secret_scanning_alerts: 'read',
                contents: 'read',
            },
        };
        const granted = aggregatePermissions([readOnly.permissions]);
        const status = computeCapabilityStatus(granted, [readOnly]);
        expect(status.missing).toEqual(['github.provision']);
        const group = status.missingByPermission.find(
            (g) => g.permission === 'contents',
        );
        expect(group?.access).toBe('write');
        expect(group?.installations.map((i) => i.login)).toEqual(['wishborn']);
    });
});

describe('buildFeatureManager (fancy-features pre-strategy gate)', () => {
    it('denies a feature whose permission is MISSING and allows one that is satisfied', async () => {
        const satisfiedSet = new Set<CapabilityKey>([
            'issue-watch.issues',
            'issue-watch.pulls',
            'issue-watch.dependabot',
        ]);
        const features = buildFeatureManager(() => satisfiedSet);

        // Satisfied → canAccess true.
        expect(await features.canAccess('issue-watch.issues')).toBe(true);
        // Missing (not in the satisfied set) → canAccess false.
        expect(await features.canAccess('github.provision')).toBe(false);
    });

    it('re-reads the satisfied set live — a later grant flips canAccess on', async () => {
        const satisfiedSet = new Set<CapabilityKey>();
        const features = buildFeatureManager(() => satisfiedSet);

        expect(await features.canAccess('github.provision')).toBe(false);
        // Owner approves the permission + reconnect re-detects → set grows.
        satisfiedSet.add('github.provision');
        expect(await features.canAccess('github.provision')).toBe(true);
    });

    it('the pre-strategy is authoritative via explain()', async () => {
        const features = buildFeatureManager(() => new Set<CapabilityKey>());
        const result = await features.explain('issue-watch.issues');
        expect(result.allowed).toBe(false);
    });

    it('defers (does not gate) an unknown, non-GitHub feature key', async () => {
        // A key with no REQUIRED entry returns null from the pre-strategy →
        // falls through to normal resolution (no registered feature → deny by
        // default, but NOT because of the github-capability gate). We assert it
        // is not force-allowed by our strategy: an unknown key resolves false.
        const features = buildFeatureManager(() => new Set<CapabilityKey>());
        expect(await features.canAccess('some.other.feature')).toBe(false);
    });
});
