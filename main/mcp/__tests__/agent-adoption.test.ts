import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ADOPTING an agent that is on disk but not in the registry (genie#465).
 *
 * `deletion.ts` keeps every `.agents/*` file through an unmount because "keeping
 * every `.agents/*` file is the entire point", and nothing ever read one back.
 * Adoption is the reader: it takes the file's own purpose, driver and scope and
 * registers an agent from them.
 *
 * ## The property this file exists to hold
 *
 * `persona.ts:96` states it: *"Registration only writes the file when it does
 * not already exist."* Adoption is registration pointed at a file somebody
 * WROTE — a persona that is a product deliverable in two of the three cases that
 * prompted this — so an adoption that overwrote it would destroy the thing it
 * was asked to recover, and the loss would be silent and total.
 *
 * That guard had no test. It has one now, and it is asserted on BYTES rather
 * than on "the file still exists": a rewrite that produced a valid AGENT.md
 * would satisfy an existence check and still have deleted the author's prompt.
 *
 * REAL: the SQLite database, real migrations, the real `registerAgentInWorkspace`
 * and the real files it does and does not write.
 * FAKED: Electron's tray bootstrap — a process boundary, reached at module load
 * through host-tools' import graph. Nothing that decides an adoption is mocked.
 */

vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { app } from 'electron';
import { addWorkspace, deleteWorkspaceAgent, initDatabase, listWorkspaceAgents } from '../../db';
import { registerAgentInWorkspace } from '../host-tools';
import { adoptionRequest, agentFilesIn } from '../../agents/roster';
import { nodeAgentFilesFs } from '../../agents/roster-fs';
import type { WorkspaceRow } from '../../db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-adopt-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-adopt';
addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Adoption Demo',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Adoption Demo',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

const ws = { id: WS_ID, path: wsDir, sacred_name: null } as unknown as WorkspaceRow;

/** Write a persona the way a HUMAN would — which is how two of the three real
 *  orphans got there. */
function writePersona(folder: string, body: string): string {
    const file = path.join(wsDir, '.agents', folder, 'AGENT.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
}

/** Adopt exactly as the IPC handler does: read the folder, build the request
 *  from the FILE, hand it to the same registration everything else uses. */
async function adopt(folder: string) {
    const file = agentFilesIn(wsDir, nodeAgentFilesFs).find((f) => f.folder === folder);
    if (!file) throw new Error(`no file for ${folder}`);
    return registerAgentInWorkspace(ws, adoptionRequest(file) as never);
}

beforeEach(() => {
    for (const a of listWorkspaceAgents(WS_ID)) deleteWorkspaceAgent(a.id);
    fs.rmSync(path.join(wsDir, '.agents'), { recursive: true, force: true });
});

describe('adopting an agent that is on disk but not registered', () => {
    it('NEVER touches the persona — not one byte', async () => {
        // A hand-authored file with no frontmatter at all: `ripple`'s real shape.
        const written = '# Ripple — the director\n\nYou are **Ripple**.\n\nThe owner is whoever installed this.\n';
        const file = writePersona('ripple', written);

        const res = await adopt('ripple');

        expect(res.ok).toBe(true);
        // BYTES, not existence. A rewrite would leave a perfectly valid
        // AGENT.md behind and would still have deleted the author's prompt.
        expect(fs.readFileSync(file, 'utf8')).toBe(written);
    });

    it('registers it under the FOLDER name, so the file it read is the file it owns', async () => {
        writePersona('trader', '# Trader\n\nYou are the trading agent.\n');

        await adopt('trader');

        const row = listWorkspaceAgents(WS_ID).find((a) => a.name === 'trader');
        expect(row).toBeDefined();
        expect(row!.persona_path).toBe(path.resolve(wsDir, '.agents', 'trader', 'AGENT.md'));
        expect(fs.existsSync(path.join(wsDir, '.agents', 'trader', 'AGENT.md'))).toBe(true);
        // POSITIVE CONTROL for the byte assertion above: adoption must not have
        // written a SECOND folder somewhere else and left this one orphaned.
        expect(fs.readdirSync(path.join(wsDir, '.agents'))).toEqual(['trader']);
    });

    it('takes the purpose the file states, not one Genie made up', async () => {
        writePersona(
            'twenty',
            '---\nname: twenty\npurpose: Works the CRM in this app\ntuis: [claude]\n---\n\nbody\n',
        );

        await adopt('twenty');

        const row = listWorkspaceAgents(WS_ID).find((a) => a.name === 'twenty');
        expect(row!.purpose).toBe('Works the CRM in this app');
        expect(row!.tui).toBe('claude');
    });

    it('falls back to the file own heading when it declares no purpose', async () => {
        writePersona('ripple', '# Ripple — the director\n\nYou are Ripple.\n');

        await adopt('ripple');

        expect(listWorkspaceAgents(WS_ID).find((a) => a.name === 'ripple')!.purpose).toBe(
            'Ripple — the director',
        );
    });

    it('boots in the folder the file scopes it to', async () => {
        fs.mkdirSync(path.join(wsDir, 'apps', 'crm'), { recursive: true });
        writePersona('scoped', '---\nname: scoped\npurpose: p\nscope: apps/crm\n---\n');

        await adopt('scoped');

        expect(listWorkspaceAgents(WS_ID).find((a) => a.name === 'scoped')!.boot_cwd).toBe(
            path.resolve(wsDir, 'apps', 'crm'),
        );
    });

    /**
     * WHY the roster refuses a folder that is not already a slug.
     *
     * This is the one refusal `registerAgentInWorkspace` does NOT make for
     * itself — it would happily register `My Agent`, derive `.agents/my-agent`
     * from the normalised name, write a persona there, and leave the folder the
     * human actually has exactly as orphaned as it was, now with a decoy beside
     * it. So the guard lives in `workspaceRoster` (asserted in
     * `agents/__tests__/roster.test.ts`) and this is the damage it prevents,
     * demonstrated against the real registration rather than described.
     */
    it('would write a SECOND folder if the roster did not refuse a non-slug name', async () => {
        writePersona('My Agent', '# My Agent');

        await registerAgentInWorkspace(ws, { name: 'My Agent', purpose: 'p' } as never);

        expect(fs.readdirSync(path.join(wsDir, '.agents')).sort()).toEqual([
            'My Agent',
            'my-agent',
        ]);
    });

    it('refuses a second adoption of the same agent rather than duplicating it', async () => {
        writePersona('trader', '# Trader\n');
        await adopt('trader');

        const again = await adopt('trader');

        expect(again.ok).toBe(false);
        expect(listWorkspaceAgents(WS_ID).filter((a) => a.name === 'trader')).toHaveLength(1);
    });
});
