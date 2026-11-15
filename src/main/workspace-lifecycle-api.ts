import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sacredNameOf } from '../core/agent-adoption.js';
import { parseRemoteChoice, type RemoteChoice } from '../core/agi-remote.js';
import { parseEnvelopePlan } from '../core/envelope-plan.js';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import { parseTynnProjectInput } from '../core/tynn.js';
import { adoptAgent, readImportedAgents, type AgentAdoptionPorts } from './agent-adoption-host.js';
import { nodeAgentConfigFs } from './agent-config-host.js';
import type { AgentEngine } from './agent-engine.js';
import { nodeEnvelopePorts } from './envelope-fs.js';
import { buildEnvelope, discardStaged, readSource, registerExisting, stageFromGit, type EnvelopePorts } from './envelope-wizard-host.js';
import { gitAddSubmodule, gitClone, gitPushMain, gitSetOrigin } from './git-ports.js';
import type { GithubAccount } from './github-account.js';
import type { GithubAccountReplica } from './github-account-replica.js';
import type { HostApiDeps } from './host-api.js';
import type { Registry } from './registry.js';
import { addRepoTo, commitsSinceIn, listReposOf, relocateRepoIn, removeRepoFrom, removeRepoLockOf, type RepoOpsPorts } from './repo-ops-host.js';
import type { TynnAccount } from './tynn-account.js';
import type { TynnAccountReplica } from './tynn-account-replica.js';
import { nodeWorkspaceFs } from './workspace-fs.js';
import { addWorkspace, addWorkspaceFromGit, addWorkspaceFromTynn, createTynnProject, createWorkspace, hibernateWorkspace, listTynnOwners, listTynnProjects, previewAddFromGit, previewAddFromTynn, previewAddWorkspace, removeWorkspace, wakeWorkspace, type WorkspaceOpsPorts } from './workspace-ops-host.js';
import { repoOpsPorts } from './workspace-reads-api.js';

/**
 * ADDING, SLEEPING AND CHANGING A WORKSPACE, ONE WIRING FOR EVERY PROCESS THAT ANSWERS IT (Tynn #553, host split P5d.5e). The
 * window and genie-host run the same operations; each passes only what it holds: its registry, its session host, its
 * terminals and supervisor, its engines, its accounts.
 */
export interface WorkspaceLifecycleWiring {
    readonly registry: () => Registry | null;
    readonly engine: () => Pick<AgentEngine, 'probe' | 'prompt' | 'stop'> | null;
    readonly finished: () => readonly { agentId: string; handoff: string | null; at: string }[];
    readonly terminals: () => WorkspaceOpsPorts['terminals'] | null;
    readonly supervisor: () => WorkspaceOpsPorts['supervisor'] | null;
    readonly engines: () => NonNullable<WorkspaceOpsPorts['engines']> | null;
    /** A fresh trust verdict before a workspace wakes: throws when there is no way to get one. */
    readonly reverifyTrust: (workspaceId: string) => Promise<void>;
    readonly github: () => GithubAccount | GithubAccountReplica | null;
    readonly tynn: () => TynnAccount | TynnAccountReplica | null;
    readonly defaultEnvFile: () => string;
    readonly stagingDirectory: () => string;
}

export interface WorkspaceLifecycle {
    readonly workspaceOps: WorkspaceOpsPorts;
    readonly envelopePorts: EnvelopePorts;
    readonly adoptionPorts: AgentAdoptionPorts;
    readonly repoOps: RepoOpsPorts;
}

export function workspaceLifecyclePorts(w: WorkspaceLifecycleWiring): WorkspaceLifecycle {
    const registry = () => w.registry()!;
    const account = (): TynnAccount | TynnAccountReplica => { const a = w.tynn(); if (!a) throw new Error('this Genie has no Tynn account'); return a; };
    const signedInGithub = () => { const g = w.github(); return g && g.view().status === 'signed-in' ? g : null; };
    const workspaceOps: WorkspaceOpsPorts = {
        reverifyTrustBeforeRedock: w.reverifyTrust,
        fs: {
            // The same functions the first-commit test drives against a real folder and git (workspace-fs.ts).
            ...nodeWorkspaceFs(),
            // The clone's own stderr is the reason a person reads; a bare exit code is not — see git-ports.ts, measured against a real git.
            // Signed in to GitHub, a repository of an account the app is installed on (with Contents) clones with that sign-in
            // (core/github.ts cloneAuthFor); anything else with the person's own git credentials, as before.
            gitClone: (url, into, branch) => { const g = w.github(); return g ? g.gitClone(url, into, branch) : gitClone(url, into, undefined, branch); },
            // A Tynn project's repositories as submodules of the envelope Genie makes for it, with the same credential.
            // The envelope wizard's Local sources (a folder on disk) need protocol.file.allow, carried the same way (git-ports.ts).
            gitAddSubmodule: (envelope, url, at, branch, local) => { const g = w.github(); return g ? g.gitAddSubmodule(envelope, url, at, branch, local) : gitAddSubmodule(envelope, url, at, branch, undefined, local); },
        },
        registry: {
            workspace: (id) => w.registry()?.workspace(id) ?? null,
            list: () => w.registry()?.listWorkspaces() ?? [],
            addWorkspace: (record) => registry().addWorkspace(record),
            agentsOf: (id) => w.registry()?.agentsOf(id) ?? [],
            setAsleep: (id, asleep) => registry().setAsleep(id, asleep),
            forgetWorkspace: (id) => registry().forgetWorkspace(id),
        },
        host: {
            probe: (id) => w.engine()?.probe(id) ?? null,
            prompt: (id, text) => w.engine()?.prompt(id, text) ?? false,
            stop: (id) => w.engine()?.stop(id) ?? false,
        },
        attention: { finished: w.finished },
        terminals: { list: () => w.terminals()?.list() ?? [], close: (id) => w.terminals()?.close(id) ?? false },
        supervisor: { list: () => w.supervisor()?.list() ?? [], stop: (id) => w.supervisor()?.stop(id) ?? false },
        // Hibernate releases the workspace's engines, wake resumes them (parity audit #12; Genie 1 hibernation.ts step 3).
        engines: {
            toRelease: (id) => w.engines()?.toRelease(id) ?? [],
            toResume: (id) => w.engines()?.toResume(id) ?? [],
            stop: async (id) => { await w.engines()?.stop(id); },
            start: async (id) => { await w.engines()?.start(id); },
        },
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        // TYNN (§6.1 add from Tynn), read at call time; signed out is refused before any request.
        tynn: {
            get host() { return w.tynn()?.host() ?? 'https://tynn.ai'; },
            projects: async () => account().projects(),
            ownerOptions: async () => account().ownerOptions(),
            createProject: async (body) => account().createProject(body),
        },
        // Settings → General "Env file name", read at each add (Add workspace parity 2b).
        defaultEnvFile: w.defaultEnvFile,
        remote: {
            git: {
                setOrigin: (path, url) => gitSetOrigin(path, url),
                pushMain: (path, url) => { const g = w.github(); return g ? g.gitPushMain(path, url) : gitPushMain(path, undefined); },
            },
            github: signedInGithub,
            // Read at call time: the Tynn account exists once it has opened.
            get tynn() { return w.tynn() ?? undefined; },
            readJson: async (p) => { try { return JSON.parse(await readFile(p, 'utf8')) as unknown; } catch { return null; } },
        },
    };
    // Its git goes through workspaceOps.fs above, so a submodule from a GitHub remote clones with the sign-in, as the clone does.
    const envelopePorts: EnvelopePorts = { ...nodeEnvelopePorts({ stagingBase: w.stagingDirectory }), github: signedInGithub };
    // The `.agents/*` a workspace brought and has not registered, and adopting one. The sacred grant is the linked Tynn
    // project's `sacred_agent_name`; signed out or unlinked grants nothing.
    const adoptionPorts: AgentAdoptionPorts = {
        workspace: (id) => w.registry()?.workspace(id) ?? null,
        agentsOf: (id) => w.registry()?.agentsOf(id) ?? [],
        listDirs: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
        readText: async (path) => { try { return await readFile(path, 'utf8'); } catch { return null; } },
        // The one write: the move of old AGENT.md front matter into project.json (Tynn #694), temp + rename.
        writeTextAtomic: nodeAgentConfigFs().writeTextAtomic,
        register: async (input) => { const record = await registry().register(input); return { id: record.id, name: record.name }; },
        sacredName: async (workspaceId) => {
            const folder = w.registry()?.workspace(workspaceId)?.path;
            const manifest = folder ? await readFile(join(folder, 'project.json'), 'utf8').catch(() => null) : null;
            const projectId = tynnProjectIdOf(manifest);
            const tynn = w.tynn();
            return projectId === null || !tynn ? null : sacredNameOf(await tynn.projects(), projectId);
        },
    };
    return { workspaceOps, envelopePorts, adoptionPorts, repoOps: repoOpsPorts((id) => w.registry()?.workspace(id) ?? null) };
}

type LifecycleKeys = 'previewAdd' | 'previewAddFromGit' | 'tynnProjects' | 'tynnOwnerOptions' | 'createTynnProject' | 'importedAgents' | 'adoptAgent' | 'previewAddFromTynn' | 'locateRepo' | 'confirmAdd' | 'create'
    | 'confirmAddFromGit' | 'readSource' | 'stageFromGit' | 'registerExisting' | 'buildEnvelope' | 'discardStaged' | 'githubRepos' | 'confirmAddFromTynn' | 'hibernate' | 'wake' | 'remove' | 'listRepos' | 'addRepo'
    | 'removeRepo' | 'removeRepoLock' | 'commitsSince' | 'setGoverns' | 'setDefaultAgent' | 'setColor' | 'setMcpServer';

const NOT_A_REMOTE = { ok: false as const, reason: 'that is not a remote Genie understands; choose None, GitHub or Paste URL' };
/** A new envelope's remote, parsed here, never trusted. No choice = None (an older window). */
const remoteOf = (raw: unknown): RemoteChoice | null | undefined => (raw === undefined || raw === null ? undefined : parseRemoteChoice(raw));

export function workspaceLifecycleApi(
    parts: WorkspaceLifecycle,
    wiring: Pick<WorkspaceLifecycleWiring, 'registry' | 'github'>,
    touch: () => void,
    setColor: (id: string, color: string) => Promise<unknown>,
): Pick<HostApiDeps['workspaceOps'], LifecycleKeys> {
    const { workspaceOps, envelopePorts, adoptionPorts, repoOps } = parts;
    return {
        previewAdd: (path) => previewAddWorkspace(workspaceOps, path),
        previewAddFromGit: async (url, parent) => { const plan = await previewAddFromGit(workspaceOps, url, parent); return plan.ok ? { ...plan, parent } : plan; },
        tynnProjects: () => listTynnProjects(workspaceOps),
        tynnOwnerOptions: () => listTynnOwners(workspaceOps),
        createTynnProject: (raw) => { const input = parseTynnProjectInput(raw); return input ? createTynnProject(workspaceOps, input) : Promise.resolve({ ok: false, reason: 'give the project a name' }); },
        importedAgents: (id) => readImportedAgents(adoptionPorts, id),
        adoptAgent: (id, name) => adoptAgent(adoptionPorts, id, name),
        previewAddFromTynn: (projectId, parent) => previewAddFromTynn(workspaceOps, parent, projectId),
        locateRepo: (id, slug, path) => relocateRepoIn(repoOps, id, slug, path),
        confirmAdd: (path) => addWorkspace(workspaceOps, path),
        create: (name, parent, raw, tynnProjectId) => {
            const remote = remoteOf(raw);
            return remote === null ? Promise.resolve(NOT_A_REMOTE) : createWorkspace(workspaceOps, name, parent, remote, tynnProjectId);
        },
        confirmAddFromGit: (url, parent) => addWorkspaceFromGit(workspaceOps, url, parent),
        readSource: (path) => readSource(workspaceOps, envelopePorts, path),
        stageFromGit: (url) => stageFromGit(workspaceOps, envelopePorts, url),
        registerExisting: (path) => registerExisting(workspaceOps, path),
        buildEnvelope: (raw, rawRemote) => {
            const plan = parseEnvelopePlan(raw);
            if (!plan) return Promise.resolve({ ok: false as const, reason: 'that is not a plan Genie can build' });
            const remote = remoteOf(rawRemote);
            return remote === null ? Promise.resolve(NOT_A_REMOTE) : buildEnvelope(workspaceOps, envelopePorts, plan, remote);
        },
        discardStaged: (path) => discardStaged(envelopePorts, path),
        githubRepos: () => { const g = wiring.github(); return g ? g.repoListing() : Promise.resolve({ status: 'signed-out' as const }); },
        confirmAddFromTynn: (parent, projectId) => addWorkspaceFromTynn(workspaceOps, parent, projectId),
        // The rail redraws the sleeping workspace.
        hibernate: (id) => hibernateWorkspace(workspaceOps, id, { handoffWaitMs: 20_000, pollMs: 500 }).finally(touch),
        wake: (id) => wakeWorkspace(workspaceOps, id),
        remove: (id) => removeWorkspace(workspaceOps, id),
        listRepos: (id) => listReposOf(repoOps, id),
        addRepo: (id, input) => addRepoTo(repoOps, id, input),
        removeRepo: (id, slug) => removeRepoFrom(repoOps, id, slug),
        removeRepoLock: (id, slug) => removeRepoLockOf(repoOps, id, slug),
        commitsSince: (id, since) => commitsSinceIn(repoOps, id, since),
        setGoverns: (id, children) => wiring.registry()!.setGoverns(id, children),
        setDefaultAgent: (id, agentId) => wiring.registry()!.setDefaultAgent(id, agentId),
        setMcpServer: (id, name, on) => wiring.registry()!.setWorkspaceMcpServer(id, name, on).finally(touch),
        setColor,
    };
}
