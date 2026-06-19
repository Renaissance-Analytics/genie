import { describe, expect, it } from 'vitest';
import {
    childAgiCloneUrl,
    provisionTargets,
    type OpsProvisionPlan,
} from '../ops-provision';

describe('childAgiCloneUrl', () => {
    it('builds the conventional github *.agi url from owner + slug', () => {
        expect(childAgiCloneUrl('acme', 'civi-web')).toBe(
            'https://github.com/acme/civi-web.agi.git',
        );
    });

    it('returns null without a usable owner (cannot guess a URL)', () => {
        expect(childAgiCloneUrl(null, 'civi-web')).toBeNull();
        expect(childAgiCloneUrl('', 'civi-web')).toBeNull();
        expect(childAgiCloneUrl('   ', 'civi-web')).toBeNull();
    });

    it('returns null without a slug', () => {
        expect(childAgiCloneUrl('acme', '')).toBeNull();
    });
});

describe('provisionTargets', () => {
    const plan = (children: OpsProvisionPlan['children']): OpsProvisionPlan => ({
        isOps: true,
        signedIn: true,
        children,
        parentPath: '/parent',
        autoProvision: false,
    });

    it('returns only missing children that have a resolvable clone URL', () => {
        const targets = provisionTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Present One',
                    slug: 'present-one',
                    status: 'present',
                    cloneUrl: null,
                    workspacePath: '/ws/present-one.agi',
                },
                {
                    projectId: 'p2',
                    name: 'Missing Two',
                    slug: 'missing-two',
                    status: 'missing',
                    cloneUrl: 'https://github.com/o/missing-two.agi.git',
                },
                {
                    projectId: 'p3',
                    name: 'Missing No URL',
                    slug: 'missing-no-url',
                    status: 'missing',
                    cloneUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([
            {
                projectId: 'p2',
                name: 'Missing Two',
                slug: 'missing-two',
                cloneUrl: 'https://github.com/o/missing-two.agi.git',
            },
        ]);
    });

    it('returns nothing when every governed child already has a workspace', () => {
        const targets = provisionTargets(
            plan([
                {
                    projectId: 'p1',
                    name: 'Present',
                    slug: 'present',
                    status: 'present',
                    cloneUrl: null,
                },
            ]),
        );
        expect(targets).toEqual([]);
    });
});
