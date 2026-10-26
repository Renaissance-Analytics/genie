import { agentOpsMenu, type AgentOpsItem } from './agent-ops-menu.js';
import type { Fidelity } from './dashboard-view.js';
import { IW_EVENT_KINDS } from './issue-watch.js';
import { isOsAgent } from './os-agent.js';

/**
 * THE AGENT SETTINGS TAB, IN SUB-TABS (agent-management parity item 3). The owner, 2026-10-21, on the one long page:
 * "the whole agent settings UX is very clunky with a lot of scrolling and wasted space"; and "I need to be able to change
 * provider as well as model ... purge an agent ... or detach it". Genie 1's AgentManager held short tabs of labelled
 * fields in a fixed-height panel; Genie 2's settings follow it.
 *
 * Which sub-tab exists and which controls it holds is decided HERE, from facts, so a test proves it without rendering:
 * absence is the mechanism (a window that cannot set a control draws none; codex has no Tools setting; an observed agent
 * is not managed and has no settings at all).
 */

export type SettingsSection = 'general' | 'permissions' | 'issuewatch' | 'persona' | 'skills';

export type SettingsControl =
    | 'provider' | 'model' | 'mode' | 'run' | 'remove'
    | 'tools' | 'access' | 'autonomous' | 'manage-tabs' | 'drive-pages'
    | 'issuewatch' | 'persona' | 'skills';

/** What the view knows: the agent, and which setters the window was given (absent setter = absent control). */
export interface SettingsFacts {
    readonly name?: string | undefined;
    readonly workspaceId?: string | undefined;
    readonly fidelity: Fidelity;
    readonly provider: string;
    /** The window can operate agents at all (`AgentOpsProps` given). */
    readonly ops: boolean;
    readonly model: boolean;
    /** The Tools setter — honoured only for Claude, whose permission modes Genie sets. */
    readonly tools: boolean;
    readonly autonomous: boolean;
    readonly manageTabs: boolean;
    readonly drivePages: boolean;
    readonly issueWatch: boolean;
    /** The agent has a persona path. */
    readonly persona: boolean;
    /** The provider reported its skills and commands. */
    readonly skills: boolean;
}

export interface SettingsSectionView {
    readonly id: SettingsSection;
    readonly label: string;
    readonly controls: readonly SettingsControl[];
}

export const SETTINGS_LABEL: Record<SettingsSection, string> = {
    general: 'General',
    permissions: 'Permissions',
    issuewatch: 'IssueWatch',
    persona: 'Persona',
    skills: 'Skills',
};

export function settingsSections(f: SettingsFacts): SettingsSectionView[] {
    if (f.fidelity !== 'declared') return [];
    const out: SettingsSectionView[] = [];
    const push = (id: SettingsSection, controls: SettingsControl[]) => { if (controls.length > 0) out.push({ id, label: SETTINGS_LABEL[id], controls }); };
    if (f.ops) {
        push('general', ['provider', ...(f.model ? ['model' as const] : []), 'mode', 'run', 'remove']);
        if (!isOsAgent(f)) push('permissions', [
            ...(f.provider === 'claude' && f.tools ? ['tools' as const] : []),
            'access',
            ...(f.autonomous ? ['autonomous' as const] : []),
            ...(f.manageTabs ? ['manage-tabs' as const] : []),
            ...(f.drivePages ? ['drive-pages' as const] : []),
        ]);
        if (f.issueWatch) push('issuewatch', ['issuewatch']);
    }
    if (f.persona) push('persona', ['persona']);
    if (f.skills) push('skills', ['skills']);
    return out;
}

/** The sub-tab shown: the one asked for when the agent has it, otherwise the first there is; `null` when there are none. */
export function settingsSectionShown(sections: readonly SettingsSectionView[], wanted: SettingsSection | null | undefined): SettingsSection | null {
    if (wanted && sections.some((s) => s.id === wanted)) return wanted;
    return sections[0]?.id ?? null;
}

export type IwGroupLabel = 'Opened' | 'Changed' | 'Activity';

/** The IssueWatch kinds in three short groups — what opened, what changed or closed, and activity on them. */
export function issueWatchGroups(kinds: typeof IW_EVENT_KINDS = IW_EVENT_KINDS): Array<{ label: IwGroupLabel; kinds: typeof IW_EVENT_KINDS }> {
    const groupOf = (kind: string): IwGroupLabel => kind.endsWith('.new') ? 'Opened' : kind.endsWith('.updated') || kind === 'closed' ? 'Changed' : 'Activity';
    return (['Opened', 'Changed', 'Activity'] as const).map((label) => ({ label, kinds: kinds.filter((k) => groupOf(k.kind) === label) }));
}

// Restart itself is the header's, one per surface (genie#1238); Run keeps the other run operations.
const RUN_IDS = new Set(['stop-agent', 'restart-fresh', 'diagnose']);
const REMOVE_IDS = new Set(['delete-unmount', 'delete-delete']);

/** The run controls on General: the operations menu's own stop/restart/diagnose items (same ids, same labels). */
export function runControls(agent: { provider: string; fidelity: string }, running: boolean): AgentOpsItem[] {
    return agentOpsMenu(agent, undefined, { running }).filter((i) => RUN_IDS.has(i.id));
}

/** The Remove area at the foot of General: the menu's Unmount from Genie… and Delete… (same ids, same confirm). */
export function removeControls(agent: { provider: string; fidelity: string }): AgentOpsItem[] {
    return agentOpsMenu(agent).filter((i) => REMOVE_IDS.has(i.id));
}

/**
 * A RESULT BESIDE THE CONTROL THAT CAUSED IT, without a new host API: the view remembers which control was touched and
 * the outcome line as it stood then; an outcome that arrives AFTER the touch is that control's. One that was already
 * there is not (it belongs to whatever ran before). The single line under the header stays regardless.
 */
export function controlOutcome(touched: { control: SettingsControl; before: string | null } | null, lastOutcome: string | null): { control: SettingsControl; text: string } | null {
    if (!touched || lastOutcome === null || lastOutcome === touched.before) return null;
    return { control: touched.control, text: lastOutcome };
}
