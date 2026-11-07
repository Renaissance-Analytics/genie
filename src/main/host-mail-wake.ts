import { agentCapFrom } from '../core/inbox.js';
import { ReminderBook } from '../core/inbox-reminders.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { OS_WORKSPACE } from '../core/os-agent.js';
import type { HostRegistry } from './host-registry.js';
import type { InboxStore } from './inbox-store.js';
import { inboxNotices } from './inbox-notices.js';
import { appMailPushPorts, wireInboxPush } from './inbox-push.js';
import { wireIssueWatchPush, type IssueWatchQueue } from './issue-watch-push.js';
import type { SessionHost } from './session-host.js';
import type { SettingsStore } from './settings-store.js';
import { startForWork } from './start-on-demand.js';
import { startRefusal } from './workspace-ops-host.js';

/**
 * THE MAIL WAKE, IN GENIE-HOST (the host split, P3.2; the owner, 2026-10-31: "the person must never have to type for an
 * agent to get its notifications"). An agent with unread mail is told — idle at once, mid-turn at its next step — and a
 * stopped one is STARTED for it, under the refusals a person's start has (an asleep workspace, the agent cap), each said
 * by name and starting nothing. It needs nothing of a window: the inbox, the sessions, the roster and the settings are the
 * host's.
 *
 * The start uses the host's own environment and the workspace variables the last window handed over; with no window
 * since the host began, a woken agent has the host's environment only.
 */
export function wireHostMailWake(p: {
    readonly inbox: InboxStore;
    readonly host: SessionHost;
    readonly registry: HostRegistry;
    readonly settings: Pick<SettingsStore, 'snapshotFor'>;
    /** The OS agent's home: where it runs. */
    readonly osaDir: string;
    readonly log: (line: string) => void;
    /**
     * ISSUEWATCH'S QUEUE (P5c): a second source through this same wake — `push` starts a stopped agent, `next-turn` waits
     * for it to run. Absent = mail only.
     */
    readonly issueWatch?: IssueWatchQueue;
    /** SAFE MODE (Tynn #386): while on, no stopped agent is started for its mail or IssueWatch's push; the notice waits. */
    readonly safeMode?: () => boolean;
}): () => void {
    const reminders = new ReminderBook();
    const cwdFor = (record: AgentRecord): string => (record.workspaceId === OS_WORKSPACE ? p.osaDir : p.registry.workspace(record.workspaceId)?.path ?? p.osaDir);
    // The SAME refusal a person's start gets (workspace-ops-host.ts): an asleep workspace, the agent cap.
    const refusal = (record: AgentRecord): string | null => startRefusal({ registry: p.registry }, record, {
        running: p.registry.listAgents().filter((a) => a.workspaceId === record.workspaceId && p.host.probe(a.id as AgentId)?.running === true).length,
        cap: agentCapFrom(p.settings.snapshotFor(record.workspaceId)),
    });
    const wake = async (agentId: string): Promise<boolean> => {
        const record = p.registry.find(agentId);
        if (!record) return false;
        // SAFE MODE (Tynn #386): no stopped agent is started for its mail or IssueWatch's push. A running one (the person
        // started it) is told as ever; for a stopped one the notice waits.
        if (p.safeMode?.() === true && p.host.probe(record.id as AgentId)?.running !== true) {
            p.log(`a notice for ${record.name} waits: Genie is in safe mode, so nothing is started by itself`);
            return false;
        }
        const started = await startForWork({ probe: (id) => p.host.probe(id), start: (r, cwd) => p.host.start(r, cwd), cwdFor, startRefusal: refusal }, record);
        if (!started.ok) { p.log(`a notice for ${record.name} waits: ${started.reason}`); return false; }
        return started.started || p.host.probe(record.id as AgentId)?.running === true;
    };
    const offMail = wireInboxPush({
        inbox: p.inbox,
        host: p.host,
        reminders: ({ run }) => inboxNotices({
            agents: new Map(p.registry.listAgents().map((a) => [a.id as string, { name: a.name }])),
            unread: (id) => p.inbox.unread(id as AgentId),
            reminders,
            run,
        }),
        settled: (agentId, delivered) => reminders.settled(agentId, delivered),
        delivered: (agentId, mail) => {
            void p.inbox.markDelivered(agentId, mail.map((m) => m.id))
                .catch((error: unknown) => p.log(`a delivered mail receipt could not be saved: ${error instanceof Error ? error.message : String(error)}`));
        },
        wake,
        cumulative: true,
        ...appMailPushPorts({
            modeOf: (agentId) => p.registry.find(agentId)?.mode,
            now: () => Date.now(),
            schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        }),
    });
    // ISSUEWATCH (P5c): its own queue, told through this same wake — the one start path, its refusals said by name.
    const offIssueWatch = p.issueWatch ? wireIssueWatchPush({ delivery: p.issueWatch, host: p.host, wake }) : () => {};
    return () => { offMail(); offIssueWatch(); };
}
