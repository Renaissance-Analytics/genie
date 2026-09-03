/**
 * E2E fixture for the Tynn IMPORT flow (genie#355), gated on the
 * `e2e-tynn-import` harness page alone.
 *
 * WHAT IS STOOD IN FOR, AND WHAT IS NOT
 * -------------------------------------
 * Two things, both of them network:
 *
 *   1. `tynn:projects` — the project list a signed-in user would get from Tynn.
 *      The E2E profile is a throwaway with no session, so the real handler
 *      answers `[]` and the picker has nothing to route. The fixture below is
 *      shaped exactly like `TynnBackend.listProjects()` maps a `/api/v1/projects`
 *      row: one project carrying an `envelope`-kind repository, one carrying only
 *      a `code` one. That pair IS the test — the second is the positive control.
 *
 *   2. `workspaces:clone` — a real clone would need the network and a repo that
 *      exists. The mock instead MATERIALISES a real `.agi` envelope on disk at
 *      the destination the user chose, and returns its path.
 *
 * Everything after that is production: the REAL `workspaces:add` registers the
 * REAL row in the REAL database, which is what lets the spec assert that the
 * envelope path actually produced a workspace rather than merely declining the
 * upgrade wizard.
 */

import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWorkspace, removeWorkspace, setSettings } from '../db';

/** True only when the Tynn-import harness page is the one under test. */
export function isE2ETynnImport(): boolean {
    return process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_PAGE === 'e2e-tynn-import';
}

export const E2E_ENVELOPE_PROJECT_ID = 'e2e-envelope-project';
export const E2E_PLAIN_PROJECT_ID = 'e2e-plain-project';
export const E2E_ENVELOPE_URL = 'https://example.invalid/acme/product.agi.git';

/**
 * Shaped like `TynnBackend.listProjects()`'s output, field for field — a project
 * Tynn marks as an envelope AND declares the envelope repository for, and an
 * ordinary one with only a code repo.
 */
const PROJECTS = [
    {
        backend: 'tynn' as const,
        id: E2E_ENVELOPE_PROJECT_ID,
        name: 'Enveloped Product',
        slug: 'enveloped-product',
        owner_type: 'user',
        owner_name: 'e2e',
        isGapp: false,
        isWorkspace: true,
        sacredAgentName: null,
        repositories: [
            {
                url: 'https://example.invalid/acme/product.git',
                defaultBranch: 'main',
                kind: 'code' as const,
            },
            {
                url: E2E_ENVELOPE_URL,
                defaultBranch: 'main',
                kind: 'envelope' as const,
            },
        ],
    },
    {
        backend: 'tynn' as const,
        id: E2E_PLAIN_PROJECT_ID,
        name: 'Plain Product',
        slug: 'plain-product',
        owner_type: 'user',
        owner_name: 'e2e',
        isGapp: false,
        isWorkspace: false,
        sacredAgentName: null,
        repositories: [
            {
                url: 'https://example.invalid/acme/plain.git',
                defaultBranch: 'main',
                kind: 'code' as const,
            },
        ],
    },
];

/** The repo leaf a real clone would land in — same derivation as clone.ts. */
function repoLeaf(url: string): string {
    const leaf = url.trim().replace(/[/]+$/, '').split(/[/:]/).pop() ?? '';
    return leaf.replace(/\.git$/i, '') || 'repo';
}

/** Write the minimum that makes the destination a real `.agi` envelope. */
function materializeEnvelope(dest: string, name: string): void {
    fs.mkdirSync(path.join(dest, 'repos'), { recursive: true });
    fs.mkdirSync(path.join(dest, '.ai'), { recursive: true });
    fs.writeFileSync(
        path.join(dest, 'project.json'),
        `${JSON.stringify({ name, version: 1, repos: [] }, null, 4)}\n`,
        'utf8',
    );
}

export interface TynnImportSeed {
    /** The parent folder the modal offers by default, so the spec never has to
     *  drive the file picker to answer "where should it go?". */
    parentPath: string;
    /** Where the envelope lands under it. */
    expectedPath: string;
    envelopeProjectId: string;
    plainProjectId: string;
}

/**
 * Seeded BEFORE the window loads. The E2E profile is reused across runs, so this
 * also clears a workspace a previous run registered — otherwise the second run
 * would find the project already linked and (correctly) offer to open it
 * instead, which is a different screen from the one under test.
 */
export function seedTynnImportE2E(): TynnImportSeed {
    const parentPath = path.join(os.tmpdir(), 'genie-e2e-tynn-import');
    fs.rmSync(parentPath, { recursive: true, force: true });
    fs.mkdirSync(parentPath, { recursive: true });

    for (const id of [E2E_ENVELOPE_PROJECT_ID, E2E_PLAIN_PROJECT_ID]) {
        if (getWorkspace(id)) removeWorkspace(id);
    }

    // A returning user has one; pre-filling it is what lets the envelope route
    // ask its single question and be answered without a folder-tree walk.
    setSettings({ primary_workspace: parentPath });

    const seed: TynnImportSeed = {
        parentPath,
        expectedPath: path.join(parentPath, repoLeaf(E2E_ENVELOPE_URL)),
        envelopeProjectId: E2E_ENVELOPE_PROJECT_ID,
        plainProjectId: E2E_PLAIN_PROJECT_ID,
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_TYNN_IMPORT__ = seed;
    return seed;
}

export function registerTynnImportE2EMocks(): void {
    const override: typeof ipcMain.handle = (channel, listener) => {
        ipcMain.removeHandler(channel as string);
        ipcMain.handle(channel as string, listener as never);
    };

    override('tynn:projects', async () => PROJECTS);

    override(
        'workspaces:clone',
        async (_e, url: string, parentPath: string, folder?: string) => {
            const dest = path.join(parentPath, folder?.trim() || repoLeaf(url));
            materializeEnvelope(dest, repoLeaf(url));
            return { path: dest };
        },
    );
}
