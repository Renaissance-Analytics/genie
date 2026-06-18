import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decideProvision, ensureMcpGitignored } from '../provision';
import { applyServer, tynnEntry, hasTynnServer } from '../../mcp/agent-config';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

afterAll(() => cleanupTmpRoot());

describe('decideProvision', () => {
    it('is unlinked when the workspace points at no Tynn project', () => {
        expect(
            decideProvision({ linked: false, signedIn: true, alreadyConfigured: false, force: false }),
        ).toBe('unlinked');
    });

    it('is signed-out when linked but the user has no Tynn session', () => {
        expect(
            decideProvision({ linked: true, signedIn: false, alreadyConfigured: false, force: false }),
        ).toBe('signed-out');
    });

    it('is already when configured and not forced (idempotent auto-on-open)', () => {
        expect(
            decideProvision({ linked: true, signedIn: true, alreadyConfigured: true, force: false }),
        ).toBe('already');
    });

    it('re-provisions a configured workspace when forced', () => {
        expect(
            decideProvision({ linked: true, signedIn: true, alreadyConfigured: true, force: true }),
        ).toBe('provision');
    });

    it('provisions when linked, signed in, and not yet configured', () => {
        expect(
            decideProvision({ linked: true, signedIn: true, alreadyConfigured: false, force: false }),
        ).toBe('provision');
    });
});

describe('tynn server config writing', () => {
    it('writes an http entry with the bearer token under mcpServers.tynn', () => {
        const next = applyServer(null, 'tynn', tynnEntry('https://tynn.ai/mcp/tynn', 'rpk_abc.def'), true);
        expect(next).toEqual({
            mcpServers: {
                tynn: {
                    type: 'http',
                    url: 'https://tynn.ai/mcp/tynn',
                    headers: { Authorization: 'Bearer rpk_abc.def' },
                },
            },
        });
    });

    it('preserves sibling servers when adding/removing tynn', () => {
        const withGenie = { mcpServers: { genie: { type: 'http', url: 'http://127.0.0.1:5/mcp/x' } } };
        const added = applyServer(withGenie, 'tynn', tynnEntry('u', 't'), true);
        expect(added?.mcpServers).toHaveProperty('genie');
        expect(added?.mcpServers).toHaveProperty('tynn');

        const removed = applyServer(added, 'tynn', {}, false);
        expect(removed?.mcpServers).toHaveProperty('genie');
        expect(removed?.mcpServers).not.toHaveProperty('tynn');
    });

    it('hasTynnServer detects a written entry', () => {
        const dir = makeTmpDir('tynn-has');
        expect(hasTynnServer(dir)).toBe(false);
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({ mcpServers: { tynn: { type: 'http', url: 'u' } } }),
        );
        expect(hasTynnServer(dir)).toBe(true);
    });
});

describe('ensureMcpGitignored', () => {
    it('creates .gitignore with the token-bearing files when none exists', () => {
        const dir = makeTmpDir('gi-new');
        ensureMcpGitignored(dir);
        const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
        expect(gi).toContain('.mcp.json');
        expect(gi).toContain('.cursor/');
    });

    it('appends only the missing entries and is idempotent', () => {
        const dir = makeTmpDir('gi-merge');
        fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.mcp.json\n');
        ensureMcpGitignored(dir);
        const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
        // .mcp.json already present → not duplicated; .cursor/ appended.
        expect(gi.match(/\.mcp\.json/g)?.length).toBe(1);
        expect(gi).toContain('.cursor/');

        const before = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
        ensureMcpGitignored(dir);
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(before);
    });
});
