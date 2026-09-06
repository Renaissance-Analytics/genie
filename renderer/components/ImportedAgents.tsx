import { useCallback, useEffect, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import { AgentRosterList } from './Master/WorkspaceSettingsModal';
import { api } from '../lib/genie';
import type { AgentRosterEntry } from '../lib/ams-grid';
import { importedAgentsOffer } from '../lib/imported-agents';

/**
 * THE AGENTS AN IMPORTED PROJECT ALREADY HAS (genie#459).
 *
 * The owner: *"If I import a project from tynn I need to be able to get an agent
 * I've already created going, I should not have to create a new one."*
 *
 * They were never lost. `.agents/<slug>/AGENT.md` travels with the repo and
 * `workspace_agents` does not, so a project cloned onto a machine arrives with
 * every agent on disk and none registered — and the workspace that opened after
 * the import showed an empty grid whose one affordance is *create an agent*,
 * which is exactly the act that discards the identity, the saved session and
 * everything the agent knew about the project. Nothing on screen said the files
 * were there.
 *
 * This block says it, at the moment the human is asking what they just got.
 *
 * OFFERED, NEVER AUTOMATIC. It lists and it waits. Adopting whatever a clone
 * happens to contain would make `git pull` a way to gain agents, and would
 * conscript hand-authored personas — `trader` and `ripple` carry no frontmatter
 * at all because they are product deliverables of the GApps they live in, not
 * anything Genie wrote. Adoption goes through `agents:adopt`, which builds the
 * request from the FILE and never rewrites it.
 *
 * Draws NOTHING when there is nothing unregistered. A step listing an empty
 * roster is worse than no step, so the decision is a separate pure function
 * (`lib/imported-agents.ts`) and both of its answers are tested.
 */
export function ImportedAgents({
    workspaceId,
    roster: given,
    keepOpen = false,
}: {
    workspaceId: string;
    /**
     * The roster the caller has already read. Passed by the add-workspace flow,
     * which had to read it to know whether to stop at all; omitted by callers
     * that have not, and then this reads it itself.
     */
    roster?: AgentRosterEntry[];
    /**
     * The caller has ALREADY decided this is worth a screen, so keep drawing
     * even once nothing is left to adopt. Adopting the last file would otherwise
     * empty the list at the moment it becomes the confirmation that it worked.
     */
    keepOpen?: boolean;
}) {
    const [roster, setRoster] = useState<AgentRosterEntry[] | null>(given ?? null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(() => {
        void api()
            .agents.roster(workspaceId)
            .then((r) => {
                setRoster(r.roster);
                setError(r.ok ? null : (r.error ?? 'This workspace’s agents could not be read.'));
            })
            .catch((e: unknown) => {
                setRoster([]);
                setError(e instanceof Error ? e.message : String(e));
            });
    }, [workspaceId]);

    // Only when the caller brought nothing. Re-reading a roster that was just
    // handed over would flash the list and change none of it.
    useEffect(() => {
        if (given === undefined) load();
    }, [given, load]);

    const offer = importedAgentsOffer(roster ?? []);

    const run = async (
        name: string,
        action: () => Promise<{ ok: boolean; error?: string }>,
        ok: string,
    ) => {
        setBusy(name);
        setError(null);
        setNotice(null);
        try {
            const res = await action();
            if (!res.ok) setError(res.error ?? `${name} could not be reached.`);
            else setNotice(ok);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    const adopt = async (name: string) => {
        await run(
            name,
            () => api().agents.adopt(workspaceId, name),
            // NAME what happened and what it did NOT do. The file is the thing
            // the person is afraid for, so say it was left alone.
            `${name} is registered. Its .agents/${name}/AGENT.md was read, not rewritten.`,
        );
        load();
    };

    const start = (name: string) =>
        void run(name, () => api().agents.start(workspaceId, name), `${name} is starting.`);

    if (roster === null) return null;
    if (!offer.offer && !(keepOpen && roster.length > 0)) return null;

    return (
        <div
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            data-testid="imported-agents"
        >
            <div>
                <Text size="sm" style={{ fontWeight: 600 }}>
                    {offer.headline}
                </Text>
                {offer.offer && (
                    <Text
                        size="xs"
                        className="text-zinc-500"
                        style={{ display: 'block', marginTop: 4 }}
                    >
                        Their AGENT.md files came with the project; the registry that names them
                        lives on each machine, so they arrive here unregistered. Adopt one to get it
                        back — Genie reads its file, it never rewrites it — and you do not have to
                        create a new agent to have it.
                    </Text>
                )}
            </div>
            {error && <div className="set-note bad">{error}</div>}
            {notice && (
                <div className="set-note" role="status" data-testid="imported-agents-notice">
                    {notice}
                </div>
            )}
            <AgentRosterList
                entries={roster}
                busy={busy}
                onAdopt={(name) => void adopt(name)}
                onStart={start}
            />
        </div>
    );
}
