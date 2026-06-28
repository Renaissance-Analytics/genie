import { describe, expect, it } from 'vitest';
import { mergeRepoViews } from '../envelope';
import type { ProjectJsonRepo } from '../project-json';

describe('mergeRepoViews', () => {
    it('marks a registered + cloned repo as both inRegistry and onDisk', () => {
        const registry: ProjectJsonRepo[] = [
            { name: 'web', url: 'git@github.com:acme/web.git', role: 'host', path: 'repos/web' },
        ];
        const views = mergeRepoViews(registry, ['web']);
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({
            name: 'web',
            url: 'git@github.com:acme/web.git',
            role: 'host',
            inRegistry: true,
            onDisk: true,
        });
    });

    it('flags a registry repo that is not cloned (onDisk:false)', () => {
        const registry: ProjectJsonRepo[] = [{ name: 'api', url: 'u', role: 'package' }];
        const [view] = mergeRepoViews(registry, []);
        expect(view).toMatchObject({ name: 'api', inRegistry: true, onDisk: false });
        // Default checkout path is derived when project.json omits it.
        expect(view.path).toBe('repos/api');
    });

    it('surfaces an on-disk submodule the registry never learned about', () => {
        const views = mergeRepoViews([], ['stray']);
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({
            name: 'stray',
            url: null,
            role: null,
            inRegistry: false,
            onDisk: true,
        });
    });

    it('de-duplicates by name and sorts the merged view', () => {
        const registry: ProjectJsonRepo[] = [
            { name: 'zeta', url: 'z', role: 'package' },
            { name: 'alpha', url: 'a', role: 'host' },
        ];
        const views = mergeRepoViews(registry, ['alpha', 'beta']);
        expect(views.map((v) => v.name)).toEqual(['alpha', 'beta', 'zeta']);
        // 'alpha' is registered AND on disk; 'beta' is on-disk-only.
        expect(views.find((v) => v.name === 'alpha')).toMatchObject({
            inRegistry: true,
            onDisk: true,
        });
        expect(views.find((v) => v.name === 'beta')).toMatchObject({
            inRegistry: false,
            onDisk: true,
        });
    });
});
