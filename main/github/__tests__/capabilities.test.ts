import { describe, expect, it } from 'vitest';
import {
    aggregatePermissions,
    buildFeatureManager,
    computeCapabilityStatus,
    satisfies,
    type CapabilityKey,
    type GrantedPermissions,
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
            // contents NOT granted — github.provision should be missing.
        };
        const status = computeCapabilityStatus(granted);
        expect(status.satisfied).toEqual(
            expect.arrayContaining([
                'issue-watch.issues',
                'issue-watch.pulls',
                'issue-watch.dependabot',
            ]),
        );
        expect(status.missing).toEqual(['github.provision']);
        expect(status.missingPermissions).toEqual(['contents']);
    });

    it('mirrors the genie-ide reality: issues/pulls/dependabot granted, contents missing', () => {
        // The genie-ide App grants issues/pull_requests/metadata/
        // vulnerability_alerts/administration but NOT contents — so the only
        // missing capability is provisioning.
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
        expect(status.missing).toEqual(['github.provision']);
        expect(status.satisfied).toHaveLength(3);
    });

    it('everything missing when the App granted nothing', () => {
        const status = computeCapabilityStatus({});
        expect(status.satisfied).toEqual([]);
        expect(status.missing).toEqual([
            'issue-watch.issues',
            'issue-watch.pulls',
            'issue-watch.dependabot',
            'github.provision',
        ]);
        // missingPermissions is the DISTINCT set (no duplicates).
        expect(status.missingPermissions).toEqual([
            'issues',
            'pull_requests',
            'vulnerability_alerts',
            'contents',
        ]);
    });

    it('everything satisfied when every permission is granted at sufficient access', () => {
        const status = computeCapabilityStatus({
            metadata: 'read',
            issues: 'read',
            pull_requests: 'read',
            vulnerability_alerts: 'read',
            contents: 'write',
        });
        expect(status.missing).toEqual([]);
        expect(status.missingPermissions).toEqual([]);
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
