import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// host-tools' import graph reaches main/tray.ts, which runs the Electron app
// bootstrap at MODULE LOAD. Cut the chain here (same reason as the cap suite).
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { app } from 'electron';
import { formatWorkspaceMap, type WorkspaceMap } from '../protocol';
import { operatorRoleBrief } from '../../agents/os-agent';

/**
 * WHAT DOES `connectToGenie` TELL A WORKSTATION OPERATOR? (Tynn #269)
 *
 * The owner's complaint was that the operator "keeps trying to do work when it
 * should be there to help setup and diagnose the system". The charter and the
 * boot brief now say, in as many words, that it does not do project work.
 *
 * This function said the opposite, and said it more often. `connectToGenie`
 * returns it, the operator is an expected caller, and it handed the operator,
 * verbatim, on EVERY orientation call:
 *
 *   - "The repos under `repos/` are the PRIMARY resource — learn them first."
 *   - "## Repos (N) — the main thing to learn"
 *   - and, last line of the numbered plan, "then ask what they'd like to work on."
 *
 * A charter that says "do not do project work" and an orientation that ends by
 * asking which project to work on are in direct contradiction, and the
 * orientation is the one that arrives every time. An agent doing what it was
 * most recently told is not a misbehaving agent.
 *
 * Every operator assertion below is PAIRED with the same assertion on an
 * ordinary workspace. "The learn-the-repos plan is gone" passes just as well
 * against a function that deleted the plan for everybody, which would be a far
 * worse bug than the one being fixed.
 */

const BASE: WorkspaceMap = {
    root: 'C:/work/thing',
    isAgiEnvelope: true,
    hasProjectJson: true,
    hasGitmodules: true,
    knowledgeDir: 'C:/work/thing/.ai/knowledge',
    envelopeAgents: 'C:/work/thing/AGENTS.md',
    envelopeClaude: null,
    repos: [
        {
            name: 'thing',
            path: 'C:/work/thing/repos/thing',
            owner: 'acme',
            repo: 'thing',
            orientation: { readme: true, agents: true, claude: false, manifests: ['package.json'] },
        },
    ],
};

const ORDINARY: WorkspaceMap = { ...BASE };
const OPERATOR: WorkspaceMap = { ...BASE, workstationOperator: true };

/** The GUIDANCE half — everything before the machine-readable JSON block. The
 *  block is a verbatim echo of the map, so it differs whenever any field does;
 *  what is being compared here is what the agent READS. */
const prose = (map: WorkspaceMap): string => formatWorkspaceMap(map).split('```json')[0];

describe('orientation for a workstation operator', () => {
    it('does NOT tell the operator to learn the repos or ask what to work on', () => {
        const text = formatWorkspaceMap(OPERATOR);

        expect(text).not.toContain("then ask what they'd like to work on");
        expect(text).not.toContain('the main thing to learn');
        expect(text).not.toContain('The repos under `repos/` are the PRIMARY resource');
    });

    it('POSITIVE CONTROL — an ordinary workspace still gets the learn-the-repos plan', () => {
        // Without this, "the plan is gone" above is satisfied by deleting the
        // plan for every workspace on the machine.
        const text = formatWorkspaceMap(ORDINARY);

        expect(text).toContain('The repos under `repos/` are the PRIMARY resource');
        expect(text).toContain('the main thing to learn');
        expect(text).toContain("then ask what they'd like to work on");
        expect(text).toContain('For EACH repo above, read its README');
    });

    it('states the role using the SAME words the charter and the boot brief use', () => {
        // Not a fourth hand-written version of the boundary. A boundary kept as
        // several copies is one that will eventually disagree with itself, and
        // the copy that drifts is the one nobody is reading when it matters.
        const text = formatWorkspaceMap(OPERATOR);

        expect(text).toContain('WORKSTATION OPERATOR');
        expect(text).toContain(operatorRoleBrief());
    });

    it('POSITIVE CONTROL — an ordinary workspace is told none of that', () => {
        const text = formatWorkspaceMap(ORDINARY);

        expect(text).not.toContain('WORKSTATION OPERATOR');
        expect(text).not.toContain(operatorRoleBrief());
    });

    it('gives the operator a plan about the MACHINE, ending in a report not a question', () => {
        const text = formatWorkspaceMap(OPERATOR);

        expect(text).toContain('How to operate this workstation');
        // The repair verbs it actually has, named where it will read them.
        expect(text).toContain('runAgent diagnose');
        expect(text).toContain('registerAgent');
        expect(formatWorkspaceMap(ORDINARY)).not.toContain('How to operate this workstation');
    });

    it('keeps the parts of orientation that are true for EVERY agent', () => {
        // The operator branch replaces the project-shaped steps, not the whole
        // plan. The on-finish hook is how any agent stops stalling silently, and
        // an operator that lost it would be the one agent nobody hears from.
        const text = formatWorkspaceMap(OPERATOR);
        expect(text).toContain('on-finish hook so imDone fires automatically');
        expect(text).toMatch(/^1\. /m);
    });

    it('an unanswered map is silent — absence is not a designation', () => {
        // `workstationOperator` is optional, exactly like `gappDev`. A host that
        // does not populate it must produce the ordinary orientation, never a
        // half-operator one — and never a line announcing that this workspace is
        // NOT the operator, which would be noise on every workspace on the
        // machine.
        const { workstationOperator, ...unanswered } = OPERATOR;
        expect(workstationOperator).toBe(true); // the fixture really did carry it

        expect(prose(unanswered as WorkspaceMap)).toEqual(prose(ORDINARY));
        expect(prose({ ...BASE, workstationOperator: false })).toEqual(prose(ORDINARY));
    });
});

/**
 * A flag no agent can reach is not a feature. The formatter above is only half
 * the story: if `describeWorkspaceForMcp` never sets `workstationOperator`, the
 * operator branch is unreachable in production and every test above still
 * passes. So this asserts the REAL resolution, against the real database.
 */
describe('describeWorkspaceForMcp resolves the designation', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-operator-map-'));
    const dataDir = path.join(tmpRoot, 'userData');
    const opRoot = path.join(tmpRoot, 'operator');
    const projRoot = path.join(tmpRoot, 'project');
    for (const d of [dataDir, opRoot, projRoot]) fs.mkdirSync(d, { recursive: true });
    (app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

    afterAll(() => {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    });

    it('reads it from the WORKSPACE, not from the caller’s identity', async () => {
        const { addWorkspace, createTerminalSpec, initDatabase, setWorkstationOperator } =
            await import('../../db');
        const { describeWorkspaceForMcp } = await import('../host-tools');
        initDatabase(dataDir);

        const register = (id: string, root: string): void => {
            addWorkspace({
                id,
                backend: 'tynn',
                project_id: id,
                project_name: id,
                tynn_project_id: id,
                tynn_project_name: id,
                shape: 'simple',
                path: root,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: null,
                last_opened_at: null,
                created_by_genie: 0,
            });
            createTerminalSpec({
                id: `term-${id}`,
                workspace_id: id,
                label: id,
                cwd: root,
                type: 'terminal',
                meta: {},
            });
        };
        register('ws-operator', opRoot);
        register('ws-project', projRoot);
        setWorkstationOperator('ws-operator', true);

        // Keyed on the DESIGNATION any workspace can hold, never on the built-in
        // operator's `agent_id`. That identity branch would breach the pinned
        // ceiling in `main/__tests__/osa-special-cases.test.ts`, which has no
        // headroom; `isWorkstationOperator(ws.id)` is free, and it is also the
        // more honest question — a second designated workspace gets the same
        // orientation, because it has the same job.
        await expect(describeWorkspaceForMcp('term-ws-operator')).resolves.toMatchObject({
            workstationOperator: true,
        });
        // PAIRED CONTROL — same code path, same call, ordinary workspace.
        await expect(describeWorkspaceForMcp('term-ws-project')).resolves.toMatchObject({
            workstationOperator: false,
        });
    });
});
