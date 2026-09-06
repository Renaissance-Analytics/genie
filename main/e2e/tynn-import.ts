/**
 * E2E fixture for the Tynn IMPORT flow, gated on the `e2e-tynn-import` harness
 * page alone.
 *
 * WHAT IS STOOD IN FOR, AND WHAT IS NOT
 * -------------------------------------
 * ONE thing, and it is the network: `tynn:projects`, the project list a
 * signed-in user would get from Tynn. The E2E profile is a throwaway with no
 * session, so the real handler answers `[]` and the picker has nothing to route.
 * The fixture below is shaped exactly like `TynnBackend.listProjects()` maps a
 * `/api/v1/projects` row.
 *
 * Everything else is production. The repositories those projects declare are
 * REAL git repositories, materialised on this disk before the window loads, so
 * `workspaces:create` runs the real `cloneAgiEnvelope` / `convertToAgiPlan` /
 * `createAgiEnvelope` and the REAL `workspaces:add` registers what lands. There
 * is no longer a stand-in for the clone: a mocked creation is exactly the thing
 * that could not have caught this bug, which was a flow reaching the wrong
 * screen and creating nothing.
 *
 * THE FOUR PROJECTS ARE THE TEST.
 *
 *   1. `bare` — a real Tynn project with NO repositories. The defect: it used to
 *      fall into the scan-and-convert wizard in `mode: 'local'`, i.e. "go and
 *      find a folder to convert", for a workspace Tynn had already named.
 *   2. `envelope` — declares its `.agi` container. POSITIVE CONTROL: without it,
 *      "the import asked nothing" is satisfied by an import that does nothing.
 *   3. `plain` — declares an ordinary code repo. SECOND POSITIVE CONTROL: the
 *      content a project HAS must end up in the workspace, or "no repositories
 *      is fine" would be indistinguishable from "repositories are ignored".
 *   4. `agents` — a container with `.agents/*` COMMITTED IN IT (genie#459). That
 *      is how an agent reaches a second machine: the files travel with the repo
 *      and `workspace_agents` does not, so the clone lands with every agent on
 *      disk and none registered. Its two personas are deliberately unalike — one
 *      with Genie's rendered frontmatter, one hand-written with none — because
 *      the second is the shape adoption must never rewrite.
 */

import { ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
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
export const E2E_BARE_PROJECT_ID = 'e2e-bare-project';
export const E2E_AGENTS_PROJECT_ID = 'e2e-agents-project';

/**
 * The persona a HUMAN wrote — no frontmatter at all, which is the real shape of
 * `trader` and `ripple` on the owner's machine: deliverables of the GApps they
 * live in, not anything Genie rendered. Exported so the spec asserts the bytes
 * it committed rather than a copy that could drift from them.
 */
export const E2E_HAND_WRITTEN_PERSONA =
    '# Relay — the dispatcher\n\nYou are **Relay**. Hand work between the others.\n';

/** The persona REGISTRATION renders: frontmatter, then a body. */
const E2E_RENDERED_PERSONA =
    '---\nname: scout\npurpose: Reads the codebase ahead of the others\ntuis: [claude]\n---\n\nYou are scout.\n';

/** Where the fixture's real source repositories live. */
function sourcesRoot(): string {
    return path.join(os.tmpdir(), 'genie-e2e-tynn-import-sources');
}

/** `git`, with an identity, so a commit works on a runner with no global config. */
function git(cwd: string, args: string[]): void {
    execFileSync(
        'git',
        ['-c', 'user.email=e2e@genie.test', '-c', 'user.name=Genie E2E', ...args],
        { cwd, stdio: 'ignore' },
    );
}

/** A real git repo at `dir`, seeded with `files` and committed. */
function seedRepo(dir: string, files: Record<string, string>): string {
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf8');
    }
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'seed']);
    return dir;
}

export interface TynnImportSeed {
    /** The parent folder the modal offers by default, so the flow never has to
     *  drive the file picker to answer "where should it go?" — and so "it asked
     *  nothing" is a claim the spec can actually make. */
    parentPath: string;
    envelopeProjectId: string;
    plainProjectId: string;
    bareProjectId: string;
    /** Where each project's workspace lands under `parentPath`. */
    envelopePath: string;
    plainPath: string;
    barePath: string;
    agentsProjectId: string;
    agentsPath: string;
    /** The hand-written persona, so the spec can assert on the exact bytes. */
    handWrittenPersona: string;
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

    const sources = sourcesRoot();
    fs.rmSync(sources, { recursive: true, force: true });
    fs.mkdirSync(sources, { recursive: true });

    // A published `.agi` container, as a real repo — this is what the envelope
    // route clones, and cloning it for real is the point.
    seedRepo(path.join(sources, 'product.agi'), {
        'project.json': `${JSON.stringify({ name: 'Enveloped Product', version: 1, repos: [] }, null, 4)}\n`,
        'repos/.gitkeep': '',
        'CONTAINER.md': '# brought down, not made\n',
    });
    // An ordinary code repo, for the project that has one but no container.
    seedRepo(path.join(sources, 'plain'), { 'README.md': '# plain\n' });

    // A container carrying AGENTS (genie#459) — the only way an agent reaches a
    // second machine. `skills/` sits beside them holding no AGENT.md, because a
    // scan that took every subdirectory under `.agents/` would offer to adopt
    // shared instructions and skill files as if they were agents.
    seedRepo(path.join(sources, 'with-agents.agi'), {
        'project.json': `${JSON.stringify({ name: 'Imported Agents', version: 1, repos: [] }, null, 4)}\n`,
        'repos/.gitkeep': '',
        '.agents/scout/AGENT.md': E2E_RENDERED_PERSONA,
        '.agents/relay/AGENT.md': E2E_HAND_WRITTEN_PERSONA,
        '.agents/skills/SKILL.md': '# a skill, not an agent\n',
    });

    for (const id of [
        E2E_ENVELOPE_PROJECT_ID,
        E2E_PLAIN_PROJECT_ID,
        E2E_BARE_PROJECT_ID,
        E2E_AGENTS_PROJECT_ID,
    ]) {
        if (getWorkspace(id)) removeWorkspace(id);
    }

    // A returning user has one; pre-filling it is what lets an import that
    // already knows its name and its content ask nothing at all.
    setSettings({ primary_workspace: parentPath });

    const seed: TynnImportSeed = {
        parentPath,
        envelopeProjectId: E2E_ENVELOPE_PROJECT_ID,
        plainProjectId: E2E_PLAIN_PROJECT_ID,
        bareProjectId: E2E_BARE_PROJECT_ID,
        // `<workspaceSlug(name)>.agi` under the parent — the same derivation
        // `createWorkspace` uses, so the spec asserts a path rather than a glob.
        envelopePath: path.join(parentPath, 'enveloped-product.agi'),
        plainPath: path.join(parentPath, 'plain-product.agi'),
        barePath: path.join(parentPath, 'bare-project.agi'),
        agentsProjectId: E2E_AGENTS_PROJECT_ID,
        agentsPath: path.join(parentPath, 'imported-agents.agi'),
        handWrittenPersona: E2E_HAND_WRITTEN_PERSONA,
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_TYNN_IMPORT__ = seed;
    return seed;
}

/**
 * Shaped like `TynnBackend.listProjects()`'s output, field for field. Built at
 * call time because two of the three carry paths the seed just materialised.
 */
function projects() {
    const sources = sourcesRoot();
    return [
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
                    url: path.join(sources, 'plain'),
                    defaultBranch: 'main',
                    kind: 'code' as const,
                },
                {
                    url: path.join(sources, 'product.agi'),
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
                    url: path.join(sources, 'plain'),
                    defaultBranch: 'main',
                    kind: 'code' as const,
                },
            ],
        },
        {
            // A container with agents committed in it (genie#459).
            backend: 'tynn' as const,
            id: E2E_AGENTS_PROJECT_ID,
            name: 'Imported Agents',
            slug: 'imported-agents',
            owner_type: 'user',
            owner_name: 'e2e',
            isGapp: false,
            isWorkspace: true,
            sacredAgentName: null,
            repositories: [
                {
                    url: path.join(sources, 'with-agents.agi'),
                    defaultBranch: 'main',
                    kind: 'envelope' as const,
                },
            ],
        },
        {
            // THE ONE THE BUG WAS ABOUT: in Tynn, real, and holding nothing.
            backend: 'tynn' as const,
            id: E2E_BARE_PROJECT_ID,
            name: 'Bare Project',
            slug: 'bare-project',
            owner_type: 'user',
            owner_name: 'e2e',
            isGapp: false,
            isWorkspace: false,
            sacredAgentName: null,
            repositories: [],
        },
    ];
}

export function registerTynnImportE2EMocks(): void {
    const override: typeof ipcMain.handle = (channel, listener) => {
        ipcMain.removeHandler(channel as string);
        ipcMain.handle(channel as string, listener as never);
    };

    override('tynn:projects', async () => projects());

    // GitHub reports DISCONNECTED. The shared E2E mock signs a user in by
    // default, and a connected account means a new workspace also gets its
    // container repository created (`containerRepoPlan`) — a real network call
    // this spec has no business making. It is also the state that proves the
    // rule from the other side: with no GitHub at all, every one of these
    // imports must still land a workspace.
    override('github:status', async () => ({
        connected: false,
        username: null,
        needsReauth: false,
        clientIdSet: true,
        builtInClientId: true,
        usingOverride: false,
        activeClientId: 'Iv1.e2e…dev',
        storageOk: true,
        storageHint: null,
        flow: { kind: 'idle' },
    }));

    override('github:capabilities', async () => ({
        connected: false,
        satisfiedFeatures: [],
        missing: [],
        missingPermissions: [],
        missingByPermission: [],
    }));
}
