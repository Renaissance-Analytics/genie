import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * WHAT A TYNN IMPORT DOES TO AN AGENT (genie#459).
 *
 * The owner: *"If I import a project from tynn I need to be able to get an agent
 * I've already created going, I should not have to create a new one."*
 *
 * The issue named two candidate causes and asked which one it is. This file
 * MEASURES it against the real import — a real git clone of a real `.agi`
 * container into a real database — because they want different fixes and the
 * second is invisible from the first's vantage point:
 *
 *   1. the import makes a SECOND workspace row, orphaning agents against the old
 *      id; or
 *   2. the row is right and the agents were never in `workspace_agents` on this
 *      machine at all.
 *
 * The answer is 2, and the first assertions below are the proof. A Tynn import
 * keys the workspace by its PROJECT id (`add-workspace.ts` — `id: projectId ||
 * plan.unlinkedId`), so re-importing cannot fork the identity; what it cannot do
 * is carry `workspace_agents`, which lives only in the local `genie.db`. The
 * agents arrive on disk, in the clone, with no row anywhere.
 *
 * REAL: git, the filesystem, SQLite with its migrations, `createWorkspace`, the
 * roster reader and `registerAgentInWorkspace`.
 * FAKED: Electron's tray bootstrap (a process boundary reached at module load)
 * and the GitHub token lookup (this container is a folder on this disk).
 */

vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

vi.mock('../../github/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../github/storage')>()),
    getToken: () => null,
}));

import { app } from 'electron';
import { createWorkspace } from '../add-workspace';
import { createAgiEnvelope } from '../create-agi';
import { addWorkspace, getAllSettings, getWorkspace, initDatabase, listWorkspaceAgents } from '../../db';
import { adoptionRequest, agentFilesIn, workspaceRoster } from '../../agents/roster';
import { nodeAgentFilesFs } from '../../agents/roster-fs';
import { registerAgentInWorkspace } from '../../mcp/host-tools';
import type { WorkspaceRow } from '../../db';

/* Many git subprocesses per case; Windows needs the headroom. */
vi.setConfig({ testTimeout: 120_000 });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-import-agents-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

afterAll(() => {
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* Windows sometimes holds a handle briefly */
    }
});

function tmpDir(label: string): string {
    const dir = path.join(tmpRoot, `${label}-${Math.random().toString(36).slice(2, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function git(cwd: string, args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@genie.test', '-c', 'user.name=Genie Test', ...args], {
        cwd,
        stdio: 'ignore',
    });
}

/**
 * The persona a HUMAN wrote: no frontmatter at all. `trader` and `ripple` are
 * really shaped like this on the owner's machine — deliverables of the GApps
 * they live in, not anything Genie rendered.
 */
const HAND_WRITTEN = '# Trader — the operator\n\nYou are **Trader**. Watch the book.\n';

/** The persona REGISTRATION rendered: frontmatter, the way `twenty` carries it. */
const GENIE_WRITTEN =
    '---\nname: twenty\npurpose: Runs the twenty build\ntuis: [claude]\n---\n\nYou are twenty.\n';

/**
 * A published `.agi` container with agents committed into it — which is the only
 * way an agent reaches a second machine, since `genie.db` does not travel.
 */
async function publishedContainer(): Promise<string> {
    const remote = await createAgiEnvelope({
        slug: 'orbit',
        name: 'Orbit',
        parent_path: tmpDir('remote-parent'),
    });
    const write = (rel: string, body: string) => {
        const full = path.join(remote.path, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    };
    write('.agents/trader/AGENT.md', HAND_WRITTEN);
    write('.agents/twenty/AGENT.md', GENIE_WRITTEN);
    // NOT agents: `.agents/` also carries shared instructions and skills, and a
    // scan that took every subdirectory would offer to adopt both.
    write('.agents/skills/SKILL.md', '# a skill, not an agent\n');
    write('.agents/_genie/shared.md', '# shared instructions\n');
    git(remote.path, ['add', '.']);
    git(remote.path, ['commit', '-m', 'agents']);
    return remote.path;
}

/**
 * The import, exactly as `workspaces:create` runs it for a Tynn project.
 *
 * The two defaults are handed in rather than left to `createWorkspace`'s own
 * lazy `require('../db')`, which vitest's ESM transform cannot resolve. They are
 * the SAME two functions `defaultRegister` and `defaultEnvFile` reach for, so
 * the row this writes is the row the app writes — nothing about the decision is
 * stood in for.
 */
async function importFromTynn(projectId: string, url: string): Promise<WorkspaceRow> {
    return createWorkspace(
        {
            unlinkedId: 'ulid-nobody-should-see',
            name: 'Orbit',
            slug: 'orbit',
            parentPath: tmpDir('import-parent'),
            content: { kind: 'envelope', url },
            link: { projectId, projectName: 'Orbit' },
        },
        {
            register: (row) => addWorkspace(row),
            defaultEnvFile: () => getAllSettings().default_env_file ?? '.env',
        },
    );
}

/** The roster, composed the way `agentRecordRoster` composes it in `ipc.ts`. */
function rosterOf(ws: WorkspaceRow) {
    return workspaceRoster({
        registered: listWorkspaceAgents(ws.id).map((a) => ({
            id: a.id,
            name: a.name,
            purpose: a.purpose,
            role: a.role,
            tui: a.tui ?? '',
        })),
        files: agentFilesIn(ws.path, nodeAgentFilesFs),
        sacredName: ws.sacred_name,
    });
}

/**
 * A checked-out file's content with its line endings normalised.
 *
 * git rewrites LF to CRLF on checkout wherever `core.autocrlf` is on, which is
 * the Windows default — so the bytes in the clone are legitimately not the bytes
 * that were committed. Comparisons about WHAT THE CLONE BROUGHT go through here.
 * The comparison about what ADOPTION did does not: there the baseline is the
 * file as the clone left it, and any difference at all is the bug.
 */
function normalised(file: string): string {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Adopt exactly as `agentRecordAdopt` does: build the request from the FILE. */
async function adopt(ws: WorkspaceRow, folder: string) {
    const file = agentFilesIn(ws.path, nodeAgentFilesFs).find((f) => f.folder === folder);
    if (!file) throw new Error(`no .agents/${folder}/AGENT.md`);
    return registerAgentInWorkspace(ws, adoptionRequest(file) as never);
}

describe('importing a Tynn project that already has agents', () => {
    it('brings the agent FILES down and registers none of them — which cause it is', async () => {
        const url = await publishedContainer();

        const ws = await importFromTynn('proj-orbit', url);

        // CAUSE 1, ruled out: the workspace is keyed by the PROJECT, so there is
        // one row for this project and re-importing cannot fork the identity.
        expect(ws.id).toBe('proj-orbit');
        expect(getWorkspace('proj-orbit')!.path).toBe(ws.path);

        // CAUSE 2, confirmed. And its POSITIVE CONTROL right beside it: the
        // import SUCCEEDED and the agents are on this disk. "No agents" read on
        // its own is equally satisfied by an import that brought nothing.
        expect(listWorkspaceAgents(ws.id)).toEqual([]);
        expect(normalised(path.join(ws.path, '.agents/trader/AGENT.md'))).toBe(HAND_WRITTEN);
        expect(normalised(path.join(ws.path, '.agents/twenty/AGENT.md'))).toBe(GENIE_WRITTEN);
    });

    it('offers every agent it brought, and nothing that is not one', async () => {
        const ws = await importFromTynn('proj-offer', await publishedContainer());

        const roster = rosterOf(ws);

        expect(roster.map((e) => e.name)).toEqual(['trader', 'twenty']);
        expect(roster.every((e) => e.onDisk && !e.registered && !e.refusal)).toBe(true);
        // The file's own words, for a persona that declares no purpose: its H1,
        // never a sentence Genie made up.
        expect(roster.find((e) => e.name === 'trader')!.purpose).toBe('Trader — the operator');
        // `skills/` and `_genie/` hold no AGENT.md and are not agents.
        expect(roster.map((e) => e.name)).not.toContain('skills');
        expect(roster.map((e) => e.name)).not.toContain('_genie');
    });

    it('adopts them into the workspace it imported, without writing a new persona', async () => {
        const ws = await importFromTynn('proj-adopt', await publishedContainer());
        const persona = path.join(ws.path, '.agents/trader/AGENT.md');
        // The baseline is the file AS THE CLONE LEFT IT, so the comparison below
        // is about adoption alone and holds byte-for-byte on every platform.
        const asCloned = fs.readFileSync(persona);

        expect((await adopt(ws, 'trader')).ok).toBe(true);
        expect((await adopt(ws, 'twenty')).ok).toBe(true);

        expect(
            listWorkspaceAgents(ws.id)
                .map((a) => a.name)
                .sort(),
        ).toEqual(['trader', 'twenty']);
        // BYTES, not existence. A rewrite leaves a perfectly valid AGENT.md
        // behind and has still deleted the author's prompt.
        expect(fs.readFileSync(persona).equals(asCloned)).toBe(true);
        // POSITIVE CONTROL for that: the baseline is the author's work, not an
        // empty file that any comparison would satisfy.
        expect(asCloned.toString('utf8').replace(/\r\n/g, '\n')).toBe(HAND_WRITTEN);
        // Nothing was CREATED: the adopted agent points at the file that came
        // down in the clone, not at a second one under a different name.
        expect(listWorkspaceAgents(ws.id).find((a) => a.name === 'trader')!.persona_path).toBe(
            path.resolve(ws.path, '.agents', 'trader', 'AGENT.md'),
        );
        expect(fs.readdirSync(path.join(ws.path, '.agents')).sort()).toEqual([
            '_genie',
            'skills',
            'trader',
            'twenty',
        ]);
    });
});
