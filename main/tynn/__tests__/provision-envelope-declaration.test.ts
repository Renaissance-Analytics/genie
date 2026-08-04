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

    /** Make a linked workspace read as ALREADY provisioned: a literal Tynn bearer
     *  token in `.mcp.json` is what `hasTynnLiteralToken` keys off. */
    function markConfigured(dir: string): void {
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify(
                { mcpServers: { tynn: { headers: { Authorization: 'Bearer rpk.existing' } } } },
                null,
                2,
            ),
        );
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

    it('SELF-HEALS: declares the envelope for an ALREADY-provisioned .agi workspace, without re-minting', async () => {
        // THE gap that keeps IssueWatch dead for pre-existing workspaces (tynn.ai
        // #157 follow-up): the mint declares the envelope, but only fires on a
        // FRESH provision. An already-tokened `.agi` workspace never re-declared,
        // so Tynn's is_envelope stayed false and it was never polled. On 'already'
        // we now declare it out-of-band — no new token, so no `.mcp.json` churn.
        const dir = linkedWorkspace('proj-heal', true);
        markConfigured(dir); // ⇒ decision 'already'
        const mint = mintSpy();
        const declareEnvelope = vi.fn(async () => ({ isEnvelope: true }));
        const auth: TynnProvisionAuth = { ready: async () => true, mint, declareEnvelope };

        const r = await provisionWorkspaceTynn(dir, { auth });

        expect(r.status).toBe('already');
        expect(declareEnvelope).toHaveBeenCalledWith('proj-heal');
        // Critically NOT a re-mint — the existing token stays put.
        expect(mint).not.toHaveBeenCalled();
    });

    it('does NOT declare on already for a PLAIN (non-envelope) already-provisioned folder', async () => {
        const dir = linkedWorkspace('proj-plain-already', false);
        markConfigured(dir);
        const declareEnvelope = vi.fn(async () => ({ isEnvelope: false }));
        const auth: TynnProvisionAuth = { ready: async () => true, mint: mintSpy(), declareEnvelope };

        await provisionWorkspaceTynn(dir, { auth });

        expect(declareEnvelope).not.toHaveBeenCalled();
    });
});
