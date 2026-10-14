import { addressOf, inboxSettingFrom } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import type { AttentionStore } from './attention-store.js';
import type { FeedbackStore } from './feedback-store.js';
import type { InboxStore } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { TerminalsPort } from './mcp-tools-more.js';
import type { PluginToolsDeps } from './mcp-tools-plugins.js';
import type { AllToolsDeps } from './mcp-registrations.js';
import type { Caller } from './mcp-tools.js';
import type { SidecarToolsDeps } from './mcp-tools-sidecar.js';
import type { SettingsStore } from './settings-store.js';

/**
 * EVERY GENIE TOOL'S DEPENDENCIES, BUILT ONCE (the owner, 2026-10-13: doctor mode drives an agent with Genie's real
 * tools). Normal Genie and doctor mode both call `allGenieTools(genieToolDeps(parts))`: the parts differ — doctor has no
 * window, terminals or sidecars, and says so — and the wiring between them and the tools does not. Two copies of this
 * mapping would drift, and drift between copies is exactly what refused every Genie session's tool calls that day
 * (five copies of the caller check, mcp-callers `callerFrom`).
 */
export interface GenieToolParts {
    readonly inbox: InboxStore;
    readonly attention: AttentionStore;
    readonly knowledge: KnowledgeStore;
    readonly settings: Pick<SettingsStore, 'snapshot' | 'snapshotFor'>;
    readonly feedback: FeedbackStore;
    /** The person's approval of a gated action (a terminal created or written, a gated plugin tool). */
    readonly approve: (caller: Caller, action: 'create' | 'write' | 'plugin', detail: string) => Promise<'allowed' | 'denied'>;
    /** Every agent Genie knows, now. */
    readonly roster: () => readonly AgentRecord[];
    /** A Take Over terminal's id or a session's key → who is calling; anything else is nobody. */
    readonly resolveCaller: (id: string) => Caller | null;
    readonly userActive: () => boolean;
    /** Pulse a terminal's row. Whether anything received the signal. */
    readonly glow: (terminalId: string) => boolean;
    readonly thumbsUp: (caller: Caller, reason: string) => void;
    readonly openFile: (absolutePath: string, line: number | null) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly terminals: TerminalsPort;
    readonly sidecar: Pick<SidecarToolsDeps, 'register' | 'start' | 'running'>;
    readonly plugins: PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] };
}

export function genieToolDeps(p: GenieToolParts): AllToolsDeps {
    const values = () => p.settings.snapshot();
    return {
        genie: {
            inbox: p.inbox,
            attention: p.attention,
            roster: p.roster,
            resolveCaller: p.resolveCaller,
            workspaceSetting: (workspaceId) => inboxSettingFrom(p.settings.snapshotFor(workspaceId)),
            userActive: p.userActive,
            glow: p.glow,
            thumbsUp: p.thumbsUp,
            dnd: () => ({ on: values().do_not_disturb === true, reply: String(values().dnd_reply ?? '') }),
        },
        more: {
            knowledge: p.knowledge,
            terminals: p.terminals,
            approve: (caller, action, detail) => p.approve(caller, action, detail),
            resolveCaller: p.resolveCaller,
        },
        attention: { resolveCaller: p.resolveCaller, openFile: p.openFile, feedback: p.feedback },
        sidecar: {
            resolveCaller: p.resolveCaller,
            roster: p.roster,
            register: p.sidecar.register,
            start: p.sidecar.start,
            running: p.sidecar.running,
            addressOf: (record) => addressOf(record, 'full'),
        },
        plugins: {
            plugins: { tools: () => p.plugins.tools(), guard: (id) => p.plugins.guard(id) },
            run: p.plugins.run,
            approve: (caller, action, detail) => p.approve(caller, action, detail),
            resolveCaller: p.resolveCaller,
        },
    };
}
