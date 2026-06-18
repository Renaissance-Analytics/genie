import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { consolidateMcp, mcpStatus } from '../mcp';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

afterAll(() => cleanupTmpRoot());

function writeJson(file: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function makeEnvelope(): string {
    const dir = makeTmpDir('mcp-env');
    fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
    return dir;
}

describe('mcp consolidation', () => {
    it('merges servers from multiple repos (.mcp.json + .cursor/mcp.json)', () => {
        const env = makeEnvelope();
        // repo A: Claude-style .mcp.json
        writeJson(path.join(env, 'repos', 'app', '.mcp.json'), {
            mcpServers: { tynn: { command: 'tynn-mcp' } },
        });
        // repo B: Cursor-style .cursor/mcp.json
        writeJson(path.join(env, 'repos', 'lib', '.cursor', 'mcp.json'), {
            mcpServers: { docs: { url: 'https://x/mcp' } },
        });

        const before = mcpStatus(env);
        expect(before.repoServers.sort()).toEqual(['docs', 'tynn']);
        expect(before.needsConsolidation).toBe(true);

        const res = consolidateMcp(env);
        expect(res.servers.sort()).toEqual(['docs', 'tynn']);
        expect(res.files).toEqual(['.mcp.json', '.cursor/mcp.json']);

        // Both root files written with the union.
        for (const f of ['.mcp.json', path.join('.cursor', 'mcp.json')]) {
            const j = JSON.parse(fs.readFileSync(path.join(env, f), 'utf8'));
            expect(Object.keys(j.mcpServers).sort()).toEqual(['docs', 'tynn']);
        }

        const after = mcpStatus(env);
        expect(after.needsConsolidation).toBe(false);
    });

    it('keeps the root definition on a name collision (root wins)', () => {
        const env = makeEnvelope();
        writeJson(path.join(env, 'repos', 'app', '.mcp.json'), {
            mcpServers: { shared: { command: 'from-repo' } },
        });
        writeJson(path.join(env, '.mcp.json'), {
            mcpServers: { shared: { command: 'from-root' } },
        });

        consolidateMcp(env);
        const j = JSON.parse(fs.readFileSync(path.join(env, '.mcp.json'), 'utf8'));
        expect(j.mcpServers.shared.command).toBe('from-root');
    });

    it('is a no-op when no MCP config exists anywhere', () => {
        const env = makeEnvelope();
        const res = consolidateMcp(env);
        expect(res.files).toEqual([]);
        expect(fs.existsSync(path.join(env, '.mcp.json'))).toBe(false);
        expect(mcpStatus(env).needsConsolidation).toBe(false);
    });

    it('ignores plugin-provided servers (fancy-ui) when diffing the two root files', () => {
        const env = makeEnvelope();
        // The only difference between the two root files is `fancy-ui`, a
        // Claude Code plugin server — not declared by the envelope. It must
        // not register as out-of-sync.
        writeJson(path.join(env, '.mcp.json'), {
            mcpServers: {
                tynn: { command: 'tynn-mcp' },
                'fancy-ui': { command: 'fancy-ui-mcp' },
            },
        });
        writeJson(path.join(env, '.cursor', 'mcp.json'), {
            mcpServers: { tynn: { command: 'tynn-mcp' } },
        });

        const status = mcpStatus(env);
        expect(status.needsConsolidation).toBe(false);
        // fancy-ui is invisible to the status entirely.
        expect(status.rootServers).toEqual(['tynn']);
        expect(status.missingAtRoot).toEqual([]);
    });

    it('never surfaces or relocates a plugin-provided server (fancy-ui) from a repo', () => {
        const env = makeEnvelope();
        writeJson(path.join(env, 'repos', 'app', '.mcp.json'), {
            mcpServers: {
                real: { command: 'real-mcp' },
                'fancy-ui': { command: 'fancy-ui-mcp' },
            },
        });

        const status = mcpStatus(env);
        expect(status.repoServers).toEqual(['real']);
        expect(status.missingAtRoot).toEqual(['real']);

        const res = consolidateMcp(env);
        expect(res.servers).toEqual(['real']);
        const j = JSON.parse(fs.readFileSync(path.join(env, '.mcp.json'), 'utf8'));
        expect(Object.keys(j.mcpServers)).toEqual(['real']);
    });
});
