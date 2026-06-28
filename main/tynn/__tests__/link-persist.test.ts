import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    linkWorkspaceTynn,
    pickTynnLink,
    readTynnLink,
    unlinkWorkspaceTynn,
} from '../provision';
import {
    blankProjectJson,
    readProjectJson,
    writeProjectJson,
} from '../../workspace/project-json';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

afterAll(() => cleanupTmpRoot());

const LINK = {
    host: 'https://tynn.ai',
    owner: 'acme',
    project: 'demo',
    projectId: '01HLINK',
};

/** An envelope project.json (repos registry) like a real .agi workspace. */
function envelope(dir: string) {
    writeProjectJson(dir, {
        ...blankProjectJson('Demo', 'demo'),
        primaryRepo: 'web',
        repos: [{ name: 'web', url: 'git@x:web.git', role: 'host', path: 'repos/web' }],
    });
}

describe('Tynn link persistence in project.json', () => {
    it('linkWorkspaceTynn writes tynn.projectId and readTynnLink reads it back', () => {
        const dir = makeTmpDir('link');
        envelope(dir);
        linkWorkspaceTynn(dir, LINK);

        expect(readTynnLink(dir)?.projectId).toBe('01HLINK');
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
        expect(onDisk.tynn?.projectId).toBe('01HLINK');
        // The envelope's own data must survive the link write.
        expect(onDisk.repos).toHaveLength(1);
        expect(onDisk.primaryRepo).toBe('web');
    });

    it('keeps the link across later project.json writes (repo add then remove)', () => {
        const dir = makeTmpDir('link-then-repos');
        envelope(dir);
        linkWorkspaceTynn(dir, LINK);

        // Exactly what addEnvelopeRepo / removeEnvelopeRepo do to project.json:
        // re-read repos, then writeProjectJson({ repos }) — which must merge-keep tynn.
        const add = [
            ...(readProjectJson(dir)?.repos ?? []),
            { name: 'api', url: 'git@x:api.git', role: 'package' as const, path: 'repos/api' },
        ];
        writeProjectJson(dir, { repos: add });
        expect(readTynnLink(dir)?.projectId).toBe('01HLINK');

        writeProjectJson(dir, { repos: add.filter((r) => r.name !== 'api') });
        expect(readTynnLink(dir)?.projectId).toBe('01HLINK');
    });

    it('unlink writes an explicit empty marker that survives later writes', () => {
        const dir = makeTmpDir('unlink');
        envelope(dir);
        linkWorkspaceTynn(dir, LINK);
        unlinkWorkspaceTynn(dir);

        // Present-but-empty tynn block: readTynnLink is null, and the marker is
        // not re-populated by an unrelated project.json write.
        const pj = readProjectJson(dir);
        expect(Object.prototype.hasOwnProperty.call(pj ?? {}, 'tynn')).toBe(true);
        expect(readTynnLink(dir)).toBeNull();
        writeProjectJson(dir, { description: 'touched' });
        expect(readTynnLink(dir)).toBeNull();

        // Re-linking after an unlink works (merge fills the projectId back in).
        linkWorkspaceTynn(dir, LINK);
        expect(readTynnLink(dir)?.projectId).toBe('01HLINK');
    });
});

describe('pickTynnLink — project.json vs the durable workspace row', () => {
    const tynnRow = { backend: 'tynn', tynnProjectId: '01ROW', tynnProjectName: 'Row Proj' };

    it('uses project.json when it carries a linked tynn block', () => {
        expect(
            pickTynnLink({ projectJsonTynn: { projectId: '01PJ' }, hasTynnKey: true, row: tynnRow }),
        ).toEqual({ projectId: '01PJ' });
    });

    it('treats a present-but-empty tynn block as a deliberate unlink (no row fallback)', () => {
        expect(
            pickTynnLink({ projectJsonTynn: {}, hasTynnKey: true, row: tynnRow }),
        ).toBeNull();
    });

    it('falls back to the durable row when project.json has NO tynn block', () => {
        expect(
            pickTynnLink({ projectJsonTynn: undefined, hasTynnKey: false, row: tynnRow }),
        ).toEqual({ projectId: '01ROW', project: 'Row Proj' });
    });

    it('ignores a non-tynn (aionima) row', () => {
        expect(
            pickTynnLink({
                projectJsonTynn: undefined,
                hasTynnKey: false,
                row: { backend: 'aionima', tynnProjectId: '01ROW' },
            }),
        ).toBeNull();
    });

    it('is unlinked when neither project.json nor a row carry a link', () => {
        expect(
            pickTynnLink({ projectJsonTynn: undefined, hasTynnKey: false, row: null }),
        ).toBeNull();
    });
});
