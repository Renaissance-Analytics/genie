import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decideProvision, ensureMcpGitignored } from '../provision';
import {
    applyServer,
    tynnEntry,
    hasTynnServer,
    hasTynnEnvReference,
    writeWorkspaceTynnMcp,
    TYNN_TOKEN_ENV_KEY,
} from '../../mcp/agent-config';
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
    it('writes an http entry that REFERENCES the token env var (secret stays in .env)', () => {
        const next = applyServer(null, 'tynn', tynnEntry('https://tynn.ai/mcp/tynn', 'claude'), true);
        expect(next).toEqual({
            mcpServers: {
                tynn: {
                    type: 'http',
                    url: 'https://tynn.ai/mcp/tynn',
                    // `:-` keeps an unset var from breaking the whole config outside Genie.
                    headers: { Authorization: 'Bearer ${TYNN_AGENT_TOKEN}' },
                },
            },
        });
    });

    it('uses Cursor ${env:…} syntax for the .cursor entry', () => {
        const next = applyServer(null, 'tynn', tynnEntry('u', 'cursor'), true);
        expect(next).toEqual({
            mcpServers: {
                tynn: { url: 'u', headers: { Authorization: 'Bearer ${env:TYNN_AGENT_TOKEN}' } },
            },
        });
    });

    it('preserves sibling servers when adding/removing tynn', () => {
        const withGenie = { mcpServers: { genie: { type: 'http', url: 'http://127.0.0.1:5/mcp/x' } } };
        const added = applyServer(withGenie, 'tynn', tynnEntry('u', 'claude'), true);
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

    it('hasTynnEnvReference is false for the OLD literal form (so it re-provisions/migrates)', () => {
        const dir = makeTmpDir('tynn-envref-old');
        // Old build: literal token embedded in .mcp.json, no .env reference.
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({
                mcpServers: {
                    tynn: {
                        type: 'http',
                        url: 'https://tynn.ai/mcp/tynn',
                        headers: { Authorization: 'Bearer rpk_OLD.literal' },
                    },
                },
            }),
        );
        // hasTynnServer sees it (entry exists) but hasTynnEnvReference does NOT —
        // the gating that makes the auto-provisioner migrate it instead of skipping.
        expect(hasTynnServer(dir)).toBe(true);
        expect(hasTynnEnvReference(dir)).toBe(false);
    });

    it('hasTynnEnvReference is true only when the entry references the var AND .env has the token', () => {
        const dir = makeTmpDir('tynn-envref-new');
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({
                mcpServers: {
                    tynn: {
                        type: 'http',
                        url: 'https://tynn.ai/mcp/tynn',
                        headers: { Authorization: 'Bearer ${TYNN_AGENT_TOKEN}' },
                    },
                },
            }),
        );
        // Reference present but the token is NOT in .env yet → still needs provisioning.
        expect(hasTynnEnvReference(dir)).toBe(false);
        fs.writeFileSync(path.join(dir, '.env'), `${TYNN_TOKEN_ENV_KEY}=rpk_present.value\n`);
        expect(hasTynnEnvReference(dir)).toBe(true);
    });

    it('MIGRATES a literal token out of .mcp.json into the gitignored .env', () => {
        const dir = makeTmpDir('tynn-migrate');
        // An OLD-style config with the literal token embedded inline.
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({
                mcpServers: {
                    other: { type: 'http', url: 'http://x' },
                    tynn: {
                        type: 'http',
                        url: 'http://tynn/mcp/old',
                        headers: { Authorization: 'Bearer rpk_OLD.literal' },
                    },
                },
            }),
        );
        writeWorkspaceTynnMcp(dir, true, { url: 'http://tynn/mcp/new', token: 'rpk_NEW.minted' });

        // The fresh token landed in .env (preserving siblings) and is gitignored.
        const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        expect(env).toContain(`${TYNN_TOKEN_ENV_KEY}=rpk_NEW.minted`);
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');

        // .mcp.json now REFERENCES the var — no literal token remains; the
        // sibling server is preserved.
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
        expect(cfg.mcpServers.tynn.headers.Authorization).toBe('Bearer ${TYNN_AGENT_TOKEN}');
        expect(cfg.mcpServers.other).toBeTruthy();
        const raw = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8');
        expect(raw).not.toContain('rpk_OLD.literal');
        expect(raw).not.toContain('rpk_NEW.minted');
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
