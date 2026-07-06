import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decideProvision, ensureMcpGitignored } from '../provision';
import {
    applyServer,
    tynnEntry,
    hasTynnServer,
    hasTynnLiteralToken,
    healTynnLiteralToken,
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
    it('writes an http entry that EMBEDS the literal token (self-contained — no ${…} ref)', () => {
        const next = applyServer(
            null,
            'tynn',
            tynnEntry('https://tynn.ai/mcp/tynn', 'rpk_test.abc', 'claude'),
            true,
        );
        expect(next).toEqual({
            mcpServers: {
                tynn: {
                    type: 'http',
                    url: 'https://tynn.ai/mcp/tynn',
                    // Literal token — a ${VAR} ref breaks the client when the var is unset.
                    headers: { Authorization: 'Bearer rpk_test.abc' },
                },
            },
        });
        const auth = (next as { mcpServers: { tynn: { headers: { Authorization: string } } } })
            .mcpServers.tynn.headers.Authorization;
        expect(auth).not.toContain('${');
    });

    it('embeds the literal token in the .cursor entry too (no ${env:…} ref)', () => {
        const next = applyServer(null, 'tynn', tynnEntry('u', 'rpk_test.cur', 'cursor'), true);
        expect(next).toEqual({
            mcpServers: {
                tynn: { url: 'u', headers: { Authorization: 'Bearer rpk_test.cur' } },
            },
        });
    });

    it('preserves sibling servers when adding/removing tynn', () => {
        const withGenie = { mcpServers: { genie: { type: 'http', url: 'http://127.0.0.1:5/mcp/x' } } };
        const added = applyServer(withGenie, 'tynn', tynnEntry('u', 'rpk_test.x', 'claude'), true);
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

    it('hasTynnLiteralToken is FALSE for the OLD ${…} reference form (so it re-provisions)', () => {
        const dir = makeTmpDir('tynn-lit-oldref');
        // Old (broken) build: the header REFERENCES the env var instead of a literal.
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
        // hasTynnServer sees the entry, but hasTynnLiteralToken rejects the ${…} ref —
        // the gating that makes the auto-provisioner rewrite it instead of skipping.
        expect(hasTynnServer(dir)).toBe(true);
        expect(hasTynnLiteralToken(dir)).toBe(false);
    });

    it('hasTynnLiteralToken is TRUE for an embedded literal Bearer token, FALSE when empty', () => {
        const dir = makeTmpDir('tynn-lit-new');
        const write = (auth: string) =>
            fs.writeFileSync(
                path.join(dir, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        tynn: {
                            type: 'http',
                            url: 'https://tynn.ai/mcp/tynn',
                            headers: { Authorization: auth },
                        },
                    },
                }),
            );
        write('Bearer rpk_present.value');
        expect(hasTynnLiteralToken(dir)).toBe(true);
        // An empty `Bearer ` is not a real credential → still needs (re)provisioning.
        write('Bearer ');
        expect(hasTynnLiteralToken(dir)).toBe(false);
    });

    it('writeWorkspaceTynnMcp EMBEDS the new literal token + also lands it in the gitignored .env', () => {
        const dir = makeTmpDir('tynn-write-literal');
        // A prior config with an OLD literal token embedded inline + a sibling server.
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

        // The fresh token ALSO landed in .env (preserving siblings) and is gitignored.
        const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        expect(env).toContain(`${TYNN_TOKEN_ENV_KEY}=rpk_NEW.minted`);
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');

        // .mcp.json now embeds the NEW literal (self-contained) — the OLD one is gone,
        // no ${…} reference remains, and the sibling server is preserved.
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
        expect(cfg.mcpServers.tynn.headers.Authorization).toBe('Bearer rpk_NEW.minted');
        expect(cfg.mcpServers.tynn.url).toBe('http://tynn/mcp/new');
        expect(cfg.mcpServers.other).toBeTruthy();
        const raw = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8');
        expect(raw).not.toContain('rpk_OLD.literal');
        expect(raw).not.toContain('${TYNN_AGENT_TOKEN}');
    });
});

describe('healTynnLiteralToken (offline self-heal)', () => {
    const oldRefConfig = () => ({
        mcpServers: {
            other: { type: 'http', url: 'http://x' },
            tynn: {
                type: 'http',
                url: 'https://tynn.ai/mcp/proj',
                headers: { Authorization: 'Bearer ${TYNN_AGENT_TOKEN}' },
            },
        },
    });

    it('rewrites the ${…} ref form to a literal using the .env token — no re-mint', () => {
        const dir = makeTmpDir('heal-ok');
        fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(oldRefConfig()));
        fs.writeFileSync(path.join(dir, '.env'), `${TYNN_TOKEN_ENV_KEY}=rpk_env.token\n`);

        expect(hasTynnLiteralToken(dir)).toBe(false);
        expect(healTynnLiteralToken(dir)).toBe(true);
        expect(hasTynnLiteralToken(dir)).toBe(true);

        const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
        // The URL from the existing entry is preserved; the token comes from .env.
        expect(cfg.mcpServers.tynn.url).toBe('https://tynn.ai/mcp/proj');
        expect(cfg.mcpServers.tynn.headers.Authorization).toBe('Bearer rpk_env.token');
        expect(cfg.mcpServers.other).toBeTruthy(); // sibling untouched
    });

    it('is a no-op (false) when the entry is ALREADY a literal', () => {
        const dir = makeTmpDir('heal-already');
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({
                mcpServers: {
                    tynn: {
                        type: 'http',
                        url: 'u',
                        headers: { Authorization: 'Bearer rpk_already.literal' },
                    },
                },
            }),
        );
        expect(healTynnLiteralToken(dir)).toBe(false);
    });

    it('is a no-op (false) when the .env has no token to embed (leave for a re-mint)', () => {
        const dir = makeTmpDir('heal-notoken');
        fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(oldRefConfig()));
        expect(healTynnLiteralToken(dir)).toBe(false);
        expect(hasTynnLiteralToken(dir)).toBe(false);
    });

    it('is a no-op (false) when there is no tynn entry at all', () => {
        const dir = makeTmpDir('heal-noentry');
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://x' } } }),
        );
        fs.writeFileSync(path.join(dir, '.env'), `${TYNN_TOKEN_ENV_KEY}=rpk_env.token\n`);
        expect(healTynnLiteralToken(dir)).toBe(false);
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
