/**
 * HIBERNATE A WHOLE WORKSPACE, and wake it (genie#672).
 *
 * The owner: "Hibernated workspaces have all processes and terminals completely
 * shut down and do not wake up after upgrades or restarts, only when a user
 * manually wakes them up."
 *
 * Hibernating is a shutdown of ONE workspace, in this order:
 *
 *  1. **Ask for handoffs.** Every running agent is asked to write its handoff,
 *     all at once, each wait bounded — "hibernation is a specific type of
 *     shutdown", and a shutdown asks first.
 *  2. **Mark it asleep.** Before anything is killed, so a terminal or site that
 *     something tries to bring back during the shutdown is refused rather than
 *     respawned — and so a Genie that dies halfway through still boots it asleep.
 *  3. **Stop everything that runs.** Terminals and agents; scheduled tasks
 *     disarmed; sites stopped and services released (an engine nobody else
 *     holds stops with it, "so resources aren't burning for no reason").
 *  4. **Empty the inbox.** Hibernated agents "do not even list in the agent
 *     inbox, they are asleep", and their DMs are deleted.
 *
 * Waking clears the flag FIRST — every start below refuses while it is set — then
 * brings back everything enabled, as a fresh boot would.
 *
 * A step that fails is reported and the rest still run: half a shutdown that
 * stops at the first error leaves a workspace neither asleep nor awake, which is
 * worse than one with a named leftover.
 */

export interface HibernationWorkspace {
    id: string;
    name: string;
    path: string;
}

export interface HibernationAgent {
    name: string;
    /** The live terminals the handoff request goes to. */
    terminalIds: string[];
}

export interface HibernationDeps {
    workspace(id: string): HibernationWorkspace | null;
    /** The System workspace is Genie's own and is never put to sleep. */
    isSystem(id: string): boolean;
    isHibernated(id: string): boolean;
    setHibernated(id: string, on: boolean): void;
    /** Agents with a live terminal in this workspace. */
    runningAgents(id: string): HibernationAgent[];
    /** Ask one agent for its handoff and wait (bounded) for it to land. */
    requestHandoff(workspace: HibernationWorkspace, agent: HibernationAgent): Promise<boolean>;
    /** Kill every terminal the workspace has running — agents, shells, processes.
     *  Resolves with how many. */
    stopTerminals(id: string): Promise<number>;
    disarmSchedules(id: string): void;
    /** Stop the workspace's sites and release its services. */
    hibernateDevServer(id: string): Promise<{ errors: string[] }>;
    /** Delete every DM to or from this workspace's agents. Resolves how many. */
    purgeAgentInbox(id: string): number;
    /** Services back, and every enabled site. */
    wakeDevServer(id: string): Promise<void>;
    armSchedules(id: string): void;
    /** Start the workspace's autostart processes. */
    startProcesses(id: string): void;
    /** Tell every surface the workspace changed. */
    changed(): void;
}

export type HibernateResult =
    | {
          ok: true;
          handoffs: Array<{ agent: string; saved: boolean }>;
          stoppedTerminals: number;
          purgedMessages: number;
          errors: string[];
      }
    | { ok: false; error: string };

export type WakeResult = { ok: true; errors: string[] } | { ok: false; error: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Workspaces with a hibernate or wake in progress. The flag is only set once the
 * agents have answered, so without this a second click during that wait would
 * pass the "already asleep?" check and run the whole shutdown twice.
 */
const changing = new Set<string>();

export async function hibernateWorkspace(id: string, deps: HibernationDeps): Promise<HibernateResult> {
    const workspace = deps.workspace(id);
    if (!workspace) return { ok: false, error: 'That workspace is no longer registered.' };
    if (deps.isSystem(id)) return { ok: false, error: 'The System workspace is Genie’s own and cannot hibernate.' };
    if (changing.has(id)) return { ok: false, error: `${workspace.name} is already changing — wait for it to finish.` };
    if (deps.isHibernated(id)) return { ok: false, error: `${workspace.name} is already hibernating.` };
    changing.add(id);
    try {
        return await hibernate(id, workspace, deps);
    } finally {
        changing.delete(id);
    }
}

async function hibernate(id: string, workspace: HibernationWorkspace, deps: HibernationDeps): Promise<HibernateResult> {

    const errors: string[] = [];
    const attempt = async <T>(step: () => Promise<T> | T, fallback: T): Promise<T> => {
        try {
            return await step();
        } catch (e) {
            errors.push(messageOf(e));
            return fallback;
        }
    };

    // 1. Handoffs, all at once. A request that throws is an agent that saved nothing.
    const agents = await attempt(() => deps.runningAgents(id), [] as HibernationAgent[]);
    const saved = await Promise.all(
        agents.map((agent) => deps.requestHandoff(workspace, agent).catch(() => false)),
    );
    const handoffs = agents.map((agent, i) => ({ agent: agent.name, saved: saved[i] === true }));

    // 2. Asleep, before anything is killed.
    deps.setHibernated(id, true);

    // 3. Everything that runs.
    const stoppedTerminals = await attempt(() => deps.stopTerminals(id), 0);
    await attempt(() => deps.disarmSchedules(id), undefined);
    const dev = await attempt(() => deps.hibernateDevServer(id), { errors: [] as string[] });
    errors.push(...dev.errors);

    // 4. The inbox, last: a final message an agent sent during its handoff goes too.
    const purgedMessages = await attempt(() => deps.purgeAgentInbox(id), 0);

    deps.changed();
    return { ok: true, handoffs, stoppedTerminals, purgedMessages, errors };
}

export async function wakeWorkspace(id: string, deps: HibernationDeps): Promise<WakeResult> {
    const workspace = deps.workspace(id);
    if (!workspace) return { ok: false, error: 'That workspace is no longer registered.' };
    if (changing.has(id)) return { ok: false, error: `${workspace.name} is already changing — wait for it to finish.` };
    if (!deps.isHibernated(id)) return { ok: false, error: `${workspace.name} is not hibernating.` };
    changing.add(id);
    try {
        return await wake(id, deps);
    } finally {
        changing.delete(id);
    }
}

async function wake(id: string, deps: HibernationDeps): Promise<WakeResult> {

    const errors: string[] = [];
    const attempt = async (step: () => Promise<unknown> | unknown): Promise<void> => {
        try {
            await step();
        } catch (e) {
            errors.push(messageOf(e));
        }
    };

    // Awake first: every start below refuses while the flag is set.
    deps.setHibernated(id, false);
    await attempt(() => deps.wakeDevServer(id));
    await attempt(() => deps.armSchedules(id));
    await attempt(() => deps.startProcesses(id));
    deps.changed();
    return { ok: true, errors };
}

/**
 * Why a terminal may not open in this workspace, or null when it may (genie#672).
 *
 * One answer for every way a terminal is created — the renderer's panels, an
 * agent's `manageTerminals`/`runAgent`, a remote or mobile client — so none of
 * them can wake a sleeping workspace by the back door. A terminal that belongs
 * to no workspace is never refused, and neither is one whose workspace cannot be
 * asked: a question Genie cannot answer must not lock someone out of a shell.
 */
export function hibernationSpawnRefusal(
    workspaceId: string | null | undefined,
    isHibernated: (workspaceId: string) => boolean,
): string | null {
    if (!workspaceId) return null;
    try {
        if (!isHibernated(workspaceId)) return null;
    } catch {
        return null;
    }
    return 'This workspace is hibernating. Wake it to open its terminals.';
}
