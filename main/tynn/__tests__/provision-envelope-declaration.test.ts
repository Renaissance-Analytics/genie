import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { provisionWorkspaceTynn, type TynnProvisionAuth } from '../provision';
import { initDatabase } from '../../db';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

/**
 * tynn.ai#157 — the link must DECLARE that the workspace is an `.agi` envelope.
 *
 * Tynn gates IssueWatch (and the desktop reconcile) on `is_envelope`, and nothing
 * in this flow ever set it: the flag flipped only when someone hand-tagged a
 * repository `kind = envelope` in Tynn. A workspace Genie had linked, provisioned
 * and filled with repositories therefore stayed a plain Project forever, with a
 * dead feed and no signal on any surface.
 *
 * Genie is the only party that can answer this — Tynn does not read project.json
 * — so the mint carries the answer. The condition is Genie's OWN envelope
 * detector (`detectFolder` ⇒ FULL_ENVELOPE | PRE_INIT), not a new rule: a mere
 * `project.json` proves nothing, because `linkWorkspaceTynn` writes one into ANY
 * workspace it links.
 */
vi.mock('../../backend/tynn', () => ({
    TynnBackend: vi.fn(() => ({ whoami: async () => null, mintAgentToken: vi.fn() })),
    TynnAuthError: class TynnAuthError extends Error {},
}));

afterAll(() => cleanupTmpRoot());

describe('provisionWorkspaceTynn — envelope declaration', () => {
    beforeAll(() => {
        initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-envdecl-db-')));
    });

    /** A linked workspace dir; `envelope` builds the full `.agi` shape. */
    function linkedWorkspace(projectId: string, envelope: boolean): string {
        const dir = makeTmpDir(envelope ? 'ws-envelope' : 'ws-plain');
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({ tynn: { projectId }, repos: [] }, null, 2) + '\n',
        );
        if (envelope) {
            // FULL_ENVELOPE = root .git + .gitmodules + project.json.
            fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
            fs.writeFileSync(path.join(dir, '.gitmodules'), '');
        }
        return dir;
    }

    function mintSpy() {
        return vi.fn(async (projectId: string) => ({
            token: `rpk.${projectId}`,
            mcpUrl: 'https://tynn.ai/mcp/tynn',
            agent: { id: 'a1', name: 'Genie' },
            isOpsProject: false,
        }));
    }

    it('declares the envelope when the workspace IS a .agi envelope', async () => {
        const dir = linkedWorkspace('proj-env', true);
        const mint = mintSpy();
        const auth: TynnProvisionAuth = { ready: async () => true, mint };

        const r = await provisionWorkspaceTynn(dir, { auth });

        expect(r.status).toBe('provision');
        expect(mint).toHaveBeenCalledWith('proj-env', { workspaceEnvelope: true });
    });

    it('does NOT declare an envelope for a plain linked folder', async () => {
        // project.json alone is not evidence — the link itself writes one. Claiming
        // an envelope here would be worse than the bug it fixes: Tynn then REQUIRES
        // a product repository_id on every new version for that project.
        const dir = linkedWorkspace('proj-plain', false);
        const mint = mintSpy();
        const auth: TynnProvisionAuth = { ready: async () => true, mint };

        await provisionWorkspaceTynn(dir, { auth });

        expect(mint).toHaveBeenCalledWith('proj-plain', { workspaceEnvelope: false });
    });
});
