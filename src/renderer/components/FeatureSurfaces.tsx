import { deviceExpiryText, isExpiringSoon } from '../../core/device-expiry.js';
import { droneRefusal, mayBrowse } from '../../core/workstation-role.js';
import { useHostPathPicker } from './HostPathPicker.js';
import { PluginsPage } from './PluginsPage.js';
import { MarketplacePane } from './MarketplacePane.js';
import type { MarketplaceApi } from '../../core/marketplace.js';
import { SOUND_FILE_EXTENSIONS } from '../../core/custom-sound.js';
import { Fragment, useEffect, useRef, useState } from 'react';
import { McpServerPanel } from './McpServerPanel.js';
import { Avatar, Badge, Button, Icon, Input, Kbd, Modal, Progress, Select, Sidebar, Skeleton, Switch, Table, Tabs, Textarea, Tooltip, browserPlatformHints, detectPlatform } from '@particle-academy/react-fancy';
import { BINDING_SETTING, DEFAULT_HOTKEYS, bindingProblem, bindingsFrom, type BindingName, type HotkeyBindings } from '../../core/hotkeys.js';
import { DEFAULT_SEND_KEY, SEND_KEY_SETTING, keycaps, newlineKeyFor, sendKeyFrom, sendKeyProblem } from '../../core/send-key.js';
import { HotkeyCapture } from './HotkeyCapture.js';
import { acceleratorFromPress, hotkeyLabel, hotkeyProblem, newPromptId, parsePromptLibrary, removePrompt, serializePromptLibrary, upsertPrompt, type SavedPrompt } from '../../core/prompt-library.js';
import { browserRoute, classifyNavigation } from '../../core/browser-policy.js';
import { mobilePageUrl } from '../../core/mobile.js';
import { PairGuide } from './PairGuide.js';
import { toneLabel, type ToolStatus } from '../../core/toolchain.js';
import { INSTALL_KIND, REMOVE_KIND, cardKeyOfTool, cardOfAction, defaultSelection, formatElapsed, installNote, langView, nextFix, patchFor, toolchainActivity, toolchainCards, toolchainProblems, toolchainTally, type LangKey, type ToolCard, type ToolchainProblem } from '../toolchain-view.js';
import { ToolLogo } from './ToolLogo.js';
import { NAV_GROUPS, NEW_PROJECT_DEFAULTS, sectionOf, type SectionId } from '../../core/settings-nav.js';
import { SETTINGS, searchSettings, type SettingDef } from '../../core/settings.js';
import { ALERT_KINDS, SOUND_GROUPS, isAlertSoundKey, previewSound, type AlertKind } from '../../core/alerts.js';
import { playPreviewSound } from '../alert-sound.js';
import { SoundPicker } from './SoundPicker.js';
import { SoundVolume } from './SoundVolume.js';
import { previewVolume } from '../../core/sound-volume.js';
import { clientSoundValues } from '../client-sound-settings.js';
import { LIMIT_ALERTS_SETTING, LIMIT_WINDOW_CHOICES, limitAlertSound, newLimitAlertId, parseLimitAlerts, removeLimitAlert, serializeLimitAlerts, upsertLimitAlert, type LimitWindowChoice, type RateLimitAlert } from '../../core/limit-alerts.js';
import type { GithubCapability } from '../../core/github.js';
import type { FeatureAction, FeatureData, InstallPreview, ProcessLogOpen, FirewallRuleFacts, FirewallRuleView, FrontDoorStatus, HostedSite, RemoteSection, SiteEditing, ToolCheckState, ToolchainRefusal } from '../features.js';
import type { KeyringView } from '../../main/linux-keyring.js';
import { useSiteActions, type SitePending, type SiteRefusal } from '../site-actions.js';
import type { RemoteState } from '../remote-bridge.js';
import type { KnownHost } from '../remote-session.js';
import { agoText } from '../../core/remote-window.js';
import type { HostUpgradeStep } from '../../core/host-upgrade.js';
import type { RoleChange, TynnWorkstationList, TynnWorkstationRow } from '../relay-transport.js';
import type { ConnectProgress } from '../../core/connect-machine.js';
import { TynnWorkstationRows, useOpenProgress } from './ConnectMenu.js';
import type { Problem, ServiceForm, SiteFormDefaults } from '../../core/forms.js';
import { chooseEngines, switchActiveWarning, type ServiceInstance } from '../../core/services.js';
import { mailpitInboxUrl } from '../../core/mailpit-name.js';
import { deleteDataVerdict, soleHolderOf } from '../../core/service-tenancy.js';
import { AddKnowledgeForm, AddProcessForm, AddServiceForm, AddSiteForm } from './AddForms.js';
import { RowIconButton, RowMenu } from './RowMenu.js';
import { engineChoiceActions, engineName, processActions, scheduledActions, serviceActions, siteActions as siteRowActions, type RowAction } from './hosting-rows.js';
import { workspaceLabel } from '../../core/workspace-label.js';
import { flowReach } from '../../core/flow-reach.js';
import { flowSummary } from '../../core/flow-canvas.js';
import { pausedWords } from '../../core/flow-pills.js';
import { describeSchedule, formatLastRun, formatNextRun, lastFailure } from '../../core/scheduled-task.js';
import { canCheckNow, updateStatusLine } from '../../core/update-status.js';
import type { UpdateState } from '../bridge.js';
import { ProviderLogo } from './ProviderLogo.js';
import { AccountsSettings, type AccountsSettingsProps } from './AccountsSettings.js';
import { SWITCH_OFFER_WINDOWS_SETTING } from '../../core/switch-offer.js';
import { CopyAnnounce, copyWords, useCopyText } from './CopyText.js';
import { UNLOCK_WORDS } from '../../core/keyring-unlock.js';

/**
 * THE FEATURE SURFACES — Knowledge, Flows, Hosting, Toolchain, Inbox, Settings, Browser.
 *
 * One surface at a time, dense in state, with a fixed place for each fact (§3.3). Fancy components
 * throughout; nothing hand-rolled that Fancy provides. The §5 rule governs every body: data that is
 * `null` has not been asked for and draws a SKELETON (`data-skeleton`); data that is `[]` was asked
 * for and is empty, and draws the invitation. A surface never says "no results" before it has
 * looked.
 */

/** A form open inside a surface — renderer-local state; the problems are the last refused submit's. */
export type AddingForm =
    | { kind: 'site'; workspaceId: string; repoPath: string; defaults: SiteFormDefaults; problems: readonly Problem[]; phpVersions?: readonly string[] }
    | { kind: 'service'; workspaceId: string; defaults: ServiceForm; problems: readonly Problem[]; consent: { image: string; note: string; form: ServiceForm } | null };

const NO_BOUNDS = () => {};

interface SurfaceProps {
    /** The browser surface reports its box here so main can place the view. */
    readonly onBrowserBounds?: ((b: { x: number; y: number; width: number; height: number }) => void) | undefined;
    /** The workspaces a form can add into. The route names none, so the surface offers them. */
    readonly workspaces?: readonly { id: string; path: string; name?: string | undefined }[] | undefined;
    readonly adding?: AddingForm | undefined;
    readonly onCloseForm?: (() => void) | undefined;
    /** Which tab a tabbed surface opens on; the surface’s own default otherwise. */
    readonly tab?: string | undefined;
    readonly commandRun?: { processId: string; workspaceId: string } | undefined;
    readonly data: FeatureData;
    /**
     * App.tsx's answers with a Promise<ActOutcome>, so a control that shows its progress can tell success from a refusal
     * (SiteList, genie#1393); typed `void` so a surface or a test may pass any handler, and read through
     * `Promise.resolve` by renderer/site-actions.ts, where a plain return counts as done.
     */
    readonly onAction: (action: FeatureAction) => void;
    readonly onNavigate: (route: string) => void;
}

function Header({ title, children }: { title: string; children?: React.ReactNode }) {
    return (
        <div data-view-header="" className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-1)] pl-7 pr-5">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {children}
        </div>
    );
}

/** Which workspace an Add goes into: a select when there are several, nothing when there is one, a reason when none. */
function WorkspacePick({ workspaces, name }: { workspaces: readonly { id: string; path: string; name?: string | undefined }[]; name: string }) {
    if (workspaces.length === 0) return <span className="text-xs text-[var(--fg-3)]">Add a workspace first</span>;
    if (workspaces.length === 1) return <input type="hidden" name={name} value={workspaces[0]!.id} />;
    return (
        <select name={name} defaultValue={workspaces[0]!.id} aria-label="Workspace" className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
            {workspaces.map((w) => <option key={w.id} value={w.id}>{workspaceLabel(workspaces, w.id)}</option>)}
        </select>
    );
}

function pickedWorkspace(form: HTMLFormElement, workspaces: readonly { id: string; path: string; name?: string | undefined }[], name: string): { id: string; path: string; name?: string | undefined } | null {
    const id = String(new FormData(form).get(name) ?? '');
    return workspaces.find((w) => w.id === id) ?? workspaces[0] ?? null;
}

function Skeletons({ rows = 4 }: { rows?: number }) {
    return (
        <div data-skeleton className="flex flex-col gap-2 p-5">
            {Array.from({ length: rows }, (_, i) => <Skeleton key={i} shape="text" width={`${70 - i * 8}%`} />)}
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <p className="p-5 text-sm text-[var(--fg-3)]">{children}</p>;
}

export function KnowledgeSurface({ data, onAction, workspaces = [] }: SurfaceProps) {
    const { hits, query, adding, lastAdd } = data.knowledge;
    return (
        <div data-surface="knowledge" className="flex h-full min-h-0 flex-col">
            <Header title="Knowledge Graph">
                <form
                    className="flex-1"
                    onSubmit={(e) => { e.preventDefault(); onAction({ kind: 'knowledge.search', query: (new FormData(e.currentTarget).get('q') as string) ?? '' }); }}
                >
                    <Input name="q" type="search" defaultValue={query} placeholder="Search memories" leading={<Icon name="search" size="xs" />} />
                </form>
                <Button size="xs" type="button" className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'knowledge.openAdd' })}>
                    Add a memory
                </Button>
            </Header>
            {adding ? (
                <AddKnowledgeForm defaults={adding.defaults} problems={adding.problems} workspaces={workspaces} onSubmit={(form) => onAction({ kind: 'knowledge.create', form })} onCancel={() => onAction({ kind: 'knowledge.cancelForm' })} />
            ) : null}
            {lastAdd ? (
                <div data-knowledge-added className="border-b border-[var(--border-1)] px-5 py-2 text-sm">
                    <span>Added “{lastAdd.title}”.</span>
                    {lastAdd.unresolved.length > 0 ? (
                        <ul className="mt-1 list-disc pl-5 text-[var(--fg-3)]">
                            <li className="list-none pl-0 -ml-5">These links did not resolve, so no edge was made:</li>
                            {lastAdd.unresolved.map((u) => (
                                <li key={u.ref}>
                                    <span className="font-mono">[[{u.ref}]]</span> — {u.reason === 'ambiguous' ? 'more than one memory has that name; Genie does not guess' : 'no memory has that name yet'}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
            {hits === null ? (
                <Skeletons />
            ) : hits.length === 0 ? (
                <Empty>{query ? `Nothing in the graph matches “${query}”.` : 'The graph is empty. Agents and you add memories with the knowledge tool.'}</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {hits.map((h) => (
                        <li key={h.id} data-node={h.id} className="flex items-baseline gap-3 px-5 py-2">
                            <Badge variant="soft" size="sm">{h.class}</Badge>
                            <span className="font-medium">{h.title}</span>
                            <span className="truncate text-sm text-[var(--fg-3)]">{h.snippet}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

const OUTCOME_LABEL = { ran: 'ran', failed: 'failed', held: 'held back', stopped: 'stopped by quit' } as const;
/** A run's outcome in words: one a person or an agent stopped says who (Tynn #833). */
const outcomeLabel = (r: { outcome: keyof typeof OUTCOME_LABEL; stoppedBy?: string | undefined }): string =>
    r.outcome === 'stopped' && r.stoppedBy !== undefined ? (r.stoppedBy === 'you' ? 'stopped by you' : `stopped by ${r.stoppedBy}`) : OUTCOME_LABEL[r.outcome];
const OUTCOME_COLOR = { ran: 'green', failed: 'red', held: 'amber', stopped: 'amber' } as const;

type FlowRecordView = NonNullable<FeatureData['flows']>['flows'][number];

/**
 * ONE FLOW (genie#1204). A WORKFLOW, and the row says so: what starts it and each step in graph order. Its name and Open
 * open it on fancy-flow's canvas in the flow editor window. Run now acts at once, and so does Disarm (it only stops the
 * clock). Arm and Delete ASK first — `onAsk` opens the question under the row (FlowConfirm), which is what acts.
 */
export function FlowRow({ flow: f, workspaces, now, confirming, onAction, onAsk }: {
    flow: FlowRecordView;
    workspaces: readonly { id: string; path: string; name?: string | undefined }[];
    now: number;
    confirming: 'arm' | 'delete' | null;
    onAction: (action: FeatureAction) => void;
    onAsk: (kind: 'arm' | 'delete' | null) => void;
}) {
    const runs = f.runs ?? [];
    const last = runs.at(-1);
    const summary = flowSummary(f.document, now);
    const open = () => onAction({ kind: 'flows.openEditor', flowId: f.id });
    return (
        <li data-flow={f.id} className="flex flex-wrap items-center gap-3 px-5 py-2">
            <span className={`h-2 w-2 rounded-full ${f.armed ? 'bg-[var(--success)]' : 'bg-[var(--fg-4)]'}`} />
            <Button size="xs" type="button" data-flow-open={f.id} className="font-medium" title="Open on the canvas" onClick={open}>{f.name}</Button>
            <span className="font-mono text-xs text-[var(--fg-4)]">{workspaceLabel(workspaces, f.workspaceId)}</span>
            {f.refusals.length > 0 ? <Badge color="amber" variant="soft" size="sm">{f.refusals.length} refused</Badge> : null}
            {/* Held by its workspace's verdict (Tynn #364): armed or not, it fires nothing until the workspace is trusted. */}
            {f.held ? <span data-flow-held className="text-xs text-[var(--danger)]">{f.held}</span> : null}
            {last ? (
                <span data-flow-last={last.outcome} className="flex items-center gap-1 text-xs text-[var(--fg-3)]">
                    <Badge color={OUTCOME_COLOR[last.outcome]} variant="soft" size="sm">{outcomeLabel(last)}</Badge>
                    {new Date(last.at).toLocaleString()}
                </span>
            ) : (
                <span className="text-xs text-[var(--fg-4)]">not run yet</span>
            )}
            <span className="ml-auto flex gap-3">
                {f.inFlight ? <Button size="xs" type="button" data-flow-stop={f.id} className="text-[13px] text-[var(--danger)]" title="Stop this run now" onClick={() => onAction({ kind: 'flows.stop', flowId: f.id })}>Stop</Button> : null}
                <Button size="xs" type="button" className="text-[13px]" onClick={() => onAction({ kind: 'flows.runNow', flowId: f.id })}>Run now</Button>
                {f.armed ? (
                    <Button size="xs" type="button" className="text-[13px]" onClick={() => onAction({ kind: 'flows.disarm', flowId: f.id })}>Disarm</Button>
                ) : (
                    <Button size="xs" type="button" className="text-[13px]" onClick={() => onAsk('arm')}>Arm</Button>
                )}
                <Button size="xs" type="button" className="text-[13px]" onClick={open}>Open</Button>
                <Button size="xs" type="button" className="text-[13px] text-[var(--danger)]" onClick={() => onAsk('delete')}>Delete</Button>
            </span>
            {f.inFlight?.pause ? (
                <span data-flow-paused={f.id} className="flex basis-full items-center gap-2 pl-5 text-xs">
                    <Badge color="amber" variant="soft" size="sm">{pausedWords(f.inFlight.pause.resumesAtMs, (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</Badge>
                    <span className="text-[var(--fg-3)]">{f.inFlight.pause.agent} waits for its provider; the run keeps its place and goes on by itself.</span>
                    <Button size="xs" type="button" className="text-[13px]" onClick={() => onAction({ kind: 'flows.resumeLimit', flowId: f.id })}>Resume now</Button>
                    <Button size="xs" type="button" className="text-[13px]" disabled title="Switching the agent to another account comes with guided account switching">Switch account</Button>
                </span>
            ) : null}
            <span data-flow-summary={f.id} className="basis-full truncate pl-5 text-xs text-[var(--fg-3)]">{[summary.trigger, ...summary.steps].join(' → ')}</span>
            <span className="basis-full pl-5 text-[11px] text-[var(--fg-4)]">{summary.steps.length} {summary.steps.length === 1 ? 'step' : 'steps'}</span>
            {confirming ? <FlowConfirm flow={f} kind={confirming} now={now} onAction={onAction} onCancel={() => onAsk(null)} /> : null}
            {runs.length > 0 ? (
                <details data-flow-runs={f.id} className="basis-full">
                    <summary className="cursor-pointer text-xs text-[var(--fg-3)]">
                        Runs · last {runs.length}
                    </summary>
                    <ol className="mt-1 flex flex-col gap-1">
                        {[...runs].reverse().map((r, i) => { const index = runs.length - 1 - i; return (
                            <li key={`${runs.length - i}:${r.at}`} data-flow-run={r.outcome} className="flex items-baseline gap-2 text-xs">
                                <Badge color={OUTCOME_COLOR[r.outcome]} variant="soft" size="sm">{outcomeLabel(r)}</Badge>
                                <span className="text-[var(--fg-3)]">{new Date(r.at).toLocaleString()}</span>
                                <span className="text-[var(--fg-4)]">{r.trigger === 'manual' ? 'run now' : r.trigger === 'file' ? `when ${r.file ?? 'a file'} was added` : 'on schedule'}</span>
                                <Button size="xs" type="button" data-flow-review={String(index)} className="text-[var(--fg-3)]" title="Open this run's review" onClick={() => onAction({ kind: 'flows.openEditor', flowId: f.id, run: index })}>Review</Button>
                                {r.reason ? <span className="text-[var(--fg-2)]">{r.reason}</span> : null}
                                {r.steps && r.steps.length > 0 ? <RunSteps steps={r.steps} /> : null}
                            </li>
                        );})}
                    </ol>
                </details>
            ) : null}
        </li>
    );
}

/** Where a stopped run stopped (genie#1204): the step that failed or was held, then every step with how far it got. */
function RunSteps({ steps }: { steps: NonNullable<FlowRecordView['runs'][number]['steps']> }) {
    const stopped = steps.find((s) => s.outcome === 'failed' || s.outcome === 'held');
    const mark: Record<string, string> = { ran: '✓', failed: '✗', held: '⏸', 'not reached': '·' };
    return (
        <span data-flow-run-steps className="basis-full pl-2 text-[var(--fg-3)]">
            {stopped ? <span className="mr-2">Stopped at: {stopped.label}</span> : null}
            {steps.map((s) => (
                <span key={s.nodeId} data-flow-step={s.outcome} className="mr-2" title={s.outcome}>{mark[s.outcome]} {s.label}</span>
            ))}
        </span>
    );
}

/**
 * THE QUESTION BEFORE ARM OR DELETE (genie#1204). Arm names what the flow will then do with nobody watching — its
 * schedule and next run, each command, each agent (core/flow-reach.ts), as Genie 1's arm confirm did. Delete says the
 * flow and its runs go.
 */
export function FlowConfirm({ flow: f, kind, now, onAction, onCancel }: {
    flow: FlowRecordView;
    kind: 'arm' | 'delete';
    now: number;
    onAction: (action: FeatureAction) => void;
    onCancel: () => void;
}) {
    const reach = flowReach(f.document, now);
    return (
        <div data-flow-confirm={kind} className="basis-full rounded-lg border border-[var(--border-1)] bg-[var(--bg-2)] px-3 py-2 text-[13px]">
            {kind === 'arm' ? (
                <>
                    <p className="font-medium">Arm “{f.name}”?</p>
                    <p className="text-[var(--fg-3)]">
                        {reach.file
                            ? <>It runs on its own when {reach.file}.</>
                            : reach.schedule
                            ? <>It runs on its own on <code>{reach.schedule.cron}</code>{reach.schedule.nextMs !== null ? <>, next {new Date(reach.schedule.nextMs).toLocaleString()}</> : null}.</>
                            : <>It has no schedule: it runs only when you start it.</>}
                    </p>
                    {reach.steps.length > 0 ? (
                        <ul className="mt-1 list-disc pl-5 text-[var(--fg-2)]">{reach.steps.map((step) => <li key={step}>{step}</li>)}</ul>
                    ) : null}
                </>
            ) : (
                <p className="font-medium">Delete “{f.name}”? It and its run history are removed.</p>
            )}
            <span className="mt-2 flex gap-2">
                <Button size="xs" type="button" className={`rounded-md border px-2 py-0.5 ${kind === 'delete' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border-1)]'}`} onClick={() => onAction({ kind: kind === 'arm' ? 'flows.arm' : 'flows.remove', flowId: f.id })}>{kind === 'arm' ? 'Arm' : 'Delete'}</Button>
                <Button size="xs" type="button" className="rounded-md border border-[var(--border-1)] px-2 py-0.5" onClick={onCancel}>Cancel</Button>
            </span>
        </div>
    );
}

/**
 * FLOWS (§6.6) — fancy-flow WORKFLOWS (genie#1204). Each row: armed or not, the workspace, what the flow is (its trigger and
 * steps), the last run's outcome and when; Open (the canvas, in its own window), Run now (the person's one run, armed or
 * not), Arm / Disarm, Delete. Under a row that has run, "Runs" opens the history. Add a flow opens a NEW canvas in the
 * chosen workspace: a flow is drawn, not filled in (the owner, 2026-10-26: "they are fancy-flow workflows like genie 1 had").
 */
export function FlowsSurface({ data, onAction, workspaces = [] }: SurfaceProps) {
    const flows = data.flows;
    // Arm and Delete ask first (genie#1204): which flow, and which question, is open.
    const [confirming, setConfirming] = useState<{ flowId: string; kind: 'arm' | 'delete' } | null>(null);
    return (
        <div data-surface="flows" className="flex h-full min-h-0 flex-col">
            <Header title="Flows">
                <form
                    className="ml-auto flex items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'flows.newFlow', workspaceId: w.id }); }}
                >
                    <WorkspacePick workspaces={workspaces} name="workspace" />
                    <Button size="xs" type="submit" disabled={workspaces.length === 0} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                        Add a flow
                    </Button>
                </form>
            </Header>
            {flows === null ? (
                <Skeletons />
            ) : flows.flows.length === 0 ? (
                <div className="flex flex-col items-start gap-2 p-5 text-sm text-[var(--fg-3)]">
                    <p>No flows yet. A flow is a workflow you draw: a trigger (a schedule, a file landing, or you), then the steps it runs.</p>
                    {workspaces.length > 0 ? (
                        <Button size="xs" type="button" data-flow-new-empty className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'flows.newFlow', workspaceId: workspaces[0]!.id })}>
                            Build a flow on the canvas
                        </Button>
                    ) : null}
                </div>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {flows.flows.map((f) => (
                        <FlowRow
                            key={f.id}
                            flow={f}
                            workspaces={workspaces}
                            now={Date.now()}
                            confirming={confirming?.flowId === f.id ? confirming.kind : null}
                            onAction={(a) => { setConfirming(null); onAction(a); }}
                            onAsk={(kind) => setConfirming(kind === null ? null : { flowId: f.id, kind })}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * THE SITE ROWS, each with its click in flight and its refusal (genie#1393): a Start, Stop or Restart disables that row at
 * once, is never sent twice, and ends in success or the reason with Retry. The Hosting tab and a workspace's Sites modal
 * both draw this, so the rule cannot differ between them. The one place the rows hold state; SiteRow stays hook-free.
 */
export function SiteList({ sites, editing, onAction, workspaces = [] }: { sites: readonly HostedSite[]; editing: SiteEditing | null; onAction: SurfaceProps['onAction']; workspaces?: readonly { id: string; path: string; name?: string | undefined }[] }) {
    const siteActions = useSiteActions(onAction);
    return (
        <ul className="divide-y divide-[var(--border-1)]">
            {sites.map((s) => (
                <SiteRow key={s.id} site={s} editing={editing?.siteId === s.id ? editing : null} pending={siteActions.pending(s.id)} refusal={siteActions.refusal(s.id)} onAction={(a) => { siteActions.click(a); }} {...(workspaces.length > 0 ? { workspace: workspaceLabel(workspaces, s.workspaceId) } : {})} />
            ))}
        </ul>
    );
}

/** The step a site row says (genie#1393): the click in flight first, then main's own progress; `null` when settled. */
export type SiteRowStep = 'restarting' | 'stopping' | 'starting' | 'answering' | 'slow';

/** Which action a pending click sent: that control spins, the others are only disabled. */
const PENDING_ACTION: Readonly<Record<SitePending, FeatureAction['kind']>> = {
    restart: 'hosting.restartSite',
    stop: 'hosting.stopSite',
    start: 'hosting.startSite',
};

const STEP_WORDS: Readonly<Record<SiteRowStep, string>> = {
    restarting: 'restarting…',
    stopping: 'stopping…',
    starting: 'starting…',
    answering: 'starting…',
    slow: 'still starting…',
};

function siteStep(s: HostedSite, pending: SitePending | null): SiteRowStep | null {
    if (pending === 'restart') return 'restarting';
    if (pending === 'stop') return 'stopping';
    if (pending === 'start') return 'starting';
    if (s.state === 'starting') return s.step ?? 'answering';
    // The supervisor bringing a crashed process back by itself.
    if (s.state === 'restarting') return 'restarting';
    return null;
}

/**
 * ONE SITE'S ROW (§6.6) — Genie 1's site row (WorkspaceSiteManager.tsx): the host, its state and port, and what can be
 * done with it. Every control makes the same call an agent's `sites` tool makes (hosting-actions.ts):
 *
 * - **Open** (up): the site in Genie's own browser — main shows the pane and brings the browser surface up on it.
 * - **Restart** (up, Genie's own process): stopped and started again, its config and env read anew.
 * - **Stop** (up) / **Start** (down).
 * - **Edit**: the Add form, prefilled with how it is declared now, the same validation; saved to project.json.
 * - **Logs**: each of its processes' output, the supervisor's tail — there after a crash (as a Processes row's Log).
 * - **Remove**: behind a confirm that says what it does (project.json, never the folder).
 *
 * A site Genie 2 cannot serve says why and offers nothing to click. Hook-free: what is open is native `<details>` or the
 * main process's form state, so the row renders the same on the server, in a test and on screen.
 *
 * EVERY ACTION SHOWS ITS PROGRESS (genie#1393; the owner's rule: obvious actions, visible progress, never silent). A click
 * is `pending` until main answers (renderer/site-actions.ts): the row's controls are disabled at once and it says the
 * step, restarting / stopping / starting. Then main's own progress: starting while the port has not answered, still
 * starting (slow) past the first window, with Retry. It ends green (running) or red (failed or exited: the reason, and
 * Retry). A refused click says why on the row, with Retry. Icons, not words: each control is an icon named by its label.
 */
export function SiteRow({ site: s, editing, onAction, pending = null, refusal = null, workspace }: { site: HostedSite; editing: SiteEditing | null; onAction: SurfaceProps['onAction']; pending?: SitePending | null; refusal?: SiteRefusal | null; workspace?: string }) {
    const step = siteStep(s, pending);
    const busy = pending !== null;
    const up = s.state === 'running' || s.state === 'restarting' || s.state === 'external';
    // Failed (no answer past the ceiling, or the supervisor gave up) or exited: Retry starts it again on fresh ports.
    const down = (s.state === 'failed' || s.state === 'exited') && s.processIds.length > 0;
    const rowActions = siteRowActions(s, { editing: editing !== null });
    const run = (a: RowAction) => { for (const act of a.acts) onAction(act); };
    // A click whose control waits in the menu (Restart) spins the menu's button: progress is never invisible.
    const menuInFlight = busy && !rowActions.primary.some((a) => a.acts.some((x) => x.kind === PENDING_ACTION[pending!])) && rowActions.menu.some((a) => a.acts.some((x) => x.kind === PENDING_ACTION[pending!]));
    const status = step !== null ? 'progress' : up ? 'running' : down ? 'failed' : s.state === 'unservable' ? 'unservable' : 'stopped';
    // Every control is react-fancy's Button (the owner, 2026-11-01): an icon-only circle named by its label. The one whose
    // action is in flight spins (`loading`); every other lifecycle control is disabled until main answers.
    const control = (action: string, label: string, icon: string, act: FeatureAction, color?: 'red') => (
        <Button
            type="button"
            variant="circle"
            size="sm"
            icon={icon}
            {...(color ? { color } : {})}
            data-site-action={action}
            aria-label={label}
            title={label}
            disabled={busy}
            loading={busy && PENDING_ACTION[pending!] === act.kind && action !== 'retry-refused'}
            onClick={() => onAction(act)}
        />
    );
    return (
        <li data-site={s.id} className="flex flex-wrap items-center gap-3 px-5 py-2">
            <span
                data-site-status={status}
                {...(step !== null ? { 'data-site-step': step } : {})}
                title={step !== null ? STEP_WORDS[step] : s.state}
                aria-label={step !== null ? STEP_WORDS[step] : s.state}
                className="inline-flex items-center gap-1.5"
            >
                {step !== null ? (
                    <span data-site-spinner className={step === 'slow' ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'}><Icon name="loader-circle" size="sm" className="animate-spin" /></span>
                ) : status === 'running' ? (
                    <span className="text-[var(--success)]"><Icon name="circle-check" size="sm" /></span>
                ) : status === 'failed' ? (
                    <span className="text-[var(--danger)]"><Icon name="circle-x" size="sm" /></span>
                ) : (
                    <span className="text-[var(--fg-4)]"><Icon name="circle" size="sm" /></span>
                )}
            </span>
            <span className="text-sm font-medium">{s.host}</span>
            {workspace ? <Badge variant="soft" size="sm">{workspace}</Badge> : null}
            {/* The step in words: only while something is happening, and only the words needed. */}
            {step !== null ? <span className={`text-xs ${step === 'slow' ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'}`}>{STEP_WORDS[step]}</span> : null}
            {s.port !== null ? <span className="font-mono text-xs text-[var(--fg-4)]">127.0.0.1:{s.port}</span> : null}
            {/* Why it is not served — an unservable declaration, the refusal its last start met, its process's exit. */}
            {s.problem ? <span data-site-problem className="text-sm text-[var(--danger)]">{s.problem}</span> : null}
            {refusal ? (
                <span className="inline-flex items-center gap-2 text-sm text-[var(--danger)]">
                    <span data-site-refusal>{refusal.reason}</span>
                    {control('retry-refused', 'Retry', 'rotate-ccw', refusal.action, 'red')}
                </span>
            ) : null}
            {rowActions.primary.length + rowActions.menu.length === 0 ? null : (
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {rowActions.primary.map((a) => control(a.id, a.label, a.icon, a.acts[0]!))}
                    <RowMenu items={rowActions.menu} onRun={run} disabled={busy} loading={menuInFlight} />
                </span>
            )}
            {/* It has not run on this machine: exactly what Start runs, whole, before anyone presses it. */}
            {s.firstStart ? (
                <span data-site-first-start className="basis-full text-sm text-[var(--fg-3)]">
                    <span {...(s.firstStart.changed ? { 'data-site-first-start-changed': '' } : {})} className={s.firstStart.changed ? 'text-[var(--warning)]' : undefined}>
                        {s.firstStart.changed ? 'Changed since it last ran here. Start runs' : 'Not run on this machine yet. Start runs'}
                    </span>{' '}
                    <code className="break-all font-mono text-[var(--fg-1)]">{s.firstStart.runs}</code> in <code className="break-all font-mono">{s.firstStart.folder}</code>
                </span>
            ) : null}
            {editing ? (
                <div data-site-edit={s.id} className="basis-full">
                    <AddSiteForm
                        formId="edit-site"
                        submitLabel="Save"
                        defaults={{ ...editing.defaults, hint: `Editing ${editing.host}. Saved to the workspace’s project.json; a running site comes back up as edited.` }}
                        existingHosts={[]}
                        problems={editing.problems}
                        {...(editing.phpVersions ? { phpVersions: editing.phpVersions } : {})}
                        onSubmit={(f) =>
                            onAction({
                                kind: 'hosting.updateSite',
                                siteId: s.id,
                                form: {
                                    name: f.name,
                                    mode: f.mode,
                                    devServer: f.command ? { stack: editing.defaults.devServer?.stack ?? 'node', command: f.command } : null,
                                    hostPort: f.hostPort,
                                    root: f.root,
                                    spa: f.spa,
                                    // The pin the form opened on unless the person changed it — an Edit never drops it.
                                    ...(f.mode === 'php' ? { phpVersion: f.phpVersion } : {}),
                                },
                            })
                        }
                        onCancel={() => onAction({ kind: 'hosting.cancelForm' })}
                    />
                </div>
            ) : null}
            {(s.logs ?? []).map((log) => (
                <details key={log.processId} data-site-log={log.processId} className="basis-full">
                    <summary className="cursor-pointer text-xs text-[var(--fg-3)]">
                        Logs · {log.name} · last {log.lines} line{log.lines === 1 ? '' : 's'}{log.dropped > 0 ? ' (earlier output was cut)' : ''}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-1)] p-2 font-mono text-xs">{log.text}</pre>
                </details>
            ))}
        </li>
    );
}

export function HostingSurface({ data, onAction, onNavigate, adding, onCloseForm, workspaces = [], tab, commandRun }: SurfaceProps) {
    const hosting = data.hosting;
    return (
        <div data-surface="hosting" className="flex h-full min-h-0 flex-col">
            <Header title="Hosting">
                <form
                    className="ml-auto flex items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'hosting.addSite', workspaceId: w.id, repoPath: w.path }); }}
                >
                    <WorkspacePick workspaces={workspaces} name="workspace" />
                    <Button size="xs" type="submit" disabled={workspaces.length === 0} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                        Add a site
                    </Button>
                </form>
            </Header>
            {adding?.kind === 'site' ? (
                <AddSiteForm
                    root={adding.repoPath}
                    defaults={adding.defaults}
                    existingHosts={(hosting?.sites ?? []).map((s) => s.host)}
                    problems={adding.problems}
                    {...(adding.phpVersions ? { phpVersions: adding.phpVersions } : {})}
                    onSubmit={(f) =>
                        onAction({
                            kind: 'hosting.createSite',
                            workspaceId: adding.workspaceId,
                            repoPath: adding.repoPath,
                            form: {
                                name: f.name,
                                mode: f.mode,
                                devServer: f.command ? { stack: adding.defaults.devServer?.stack ?? 'node', command: f.command } : null,
                                hostPort: f.hostPort,
                                root: f.root,
                                spa: f.spa,
                                phpVersion: f.mode === 'php' ? f.phpVersion : null,
                            },
                        })
                    }
                    onCancel={() => onCloseForm?.()}
                />
            ) : null}
            {adding?.kind === 'service' ? (
                <AddServiceForm defaults={adding.defaults} problems={adding.problems} consent={adding.consent} workspaceName={workspaceLabel(workspaces, adding.workspaceId)} onSubmit={(form, consent) => onAction({ kind: 'services.create', form, consent })} onCancel={() => onCloseForm?.()} />
            ) : null}
            {hosting === null ? (
                <Skeletons />
            ) : (
                <>
                {(hosting.problems ?? []).map((p) => <p key={p} data-hosting-problem className="border-b border-[var(--border-1)] px-5 py-2 text-sm text-[var(--fg-3)]">{p}</p>)}
                <FrontDoorLines frontDoor={hosting.frontDoor} onAction={onAction} />
                <Tabs key={tab ?? 'sites'} defaultTab={tab ?? 'sites'} variant="underline" className="flex min-h-0 flex-1 flex-col">
                    <Tabs.List className="px-5">
                        <Tabs.Tab value="sites">Sites</Tabs.Tab>
                        <Tabs.Tab value="processes">Processes</Tabs.Tab>
                        <Tabs.Tab value="services">Services</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panels className="min-h-0 flex-1 overflow-auto">
                        <Tabs.Panel value="sites">
                            {hosting.sites.length === 0 ? (
                                <Empty>No sites yet. Add a site to serve a repo at its own .gen name.</Empty>
                            ) : (
                                <SiteList sites={hosting.sites} editing={hosting.editing ?? null} onAction={onAction} workspaces={workspaces} />
                            )}
                        </Tabs.Panel>
                        <Tabs.Panel value="processes">
                            <ProcessesPanel processes={hosting.processes} workspaces={workspaces} onAction={onAction} processLog={hosting.processLog ?? null} {...(commandRun ? { commandRun } : {})} />
                        </Tabs.Panel>
                        <Tabs.Panel value="services">
                            <ServicesPanel services={data.services} workspaces={workspaces} onAction={onAction} onNavigate={onNavigate} />
                        </Tabs.Panel>
                    </Tabs.Panels>
                </Tabs>
                </>
            )}
        </div>
    );
}

/**
 * THE FRONT DOOR'S LINES — each a fact with its fix beside it, shown ONLY when true (§4.5's signal
 * rule): Genie's CA read as untrusted offers the one-click trust (with the last failure's reason; nothing while the
 * store is still being read); a leaf that could not be issued says so; a declined hosts-file prompt shows the
 * error, the block to paste and where, and a retry; a port another process holds says which and offers Try again; no
 * bundled Caddy says so. All quiet → nothing.
 */
function FrontDoorLines({ frontDoor, onAction }: { frontDoor: FrontDoorStatus; onAction: SurfaceProps['onAction'] }) {
    const button = 'ml-auto shrink-0 rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    if (!frontDoor.running) {
        // A port another process holds is the person's to free; Try again asks again and starts the front door when it is.
        if (frontDoor.blocked) {
            return (
                <div data-frontdoor-line="blocked" className="flex items-center gap-3 px-5 py-2 text-sm">
                    <span className="flex-1">{frontDoor.reason}</span>
                    <Button size="xs" type="button" className={button} onClick={() => onAction({ kind: 'hosting.retryFrontDoor' })}>Try again</Button>
                </div>
            );
        }
        return <p data-frontdoor-line="off" className="px-5 py-2 text-sm text-[var(--fg-3)]">{frontDoor.reason}</p>;
    }
    const hosts = frontDoor.hosts;
    return (
        <>
            {frontDoor.trusted === false ? (
                <div data-frontdoor-line="trust" className="flex items-center gap-3 border-b border-[var(--border-1)] px-5 py-2 text-sm">
                    <span>
                        https://&lt;name&gt;.gen in your browser needs Genie’s certificate trusted; your OS will ask for permission once.
                        {frontDoor.trustError ? <span data-trust-error className="block text-[var(--fg-3)]">{frontDoor.trustError}</span> : null}
                    </span>
                    <Button size="xs" type="button" className={button} onClick={() => onAction({ kind: 'hosting.trustCertificate' })}>Trust certificate</Button>
                </div>
            ) : null}
            {frontDoor.certificateError ? (
                <p data-frontdoor-line="certificate" className="border-b border-[var(--border-1)] px-5 py-2 text-sm">{frontDoor.certificateError}</p>
            ) : null}
            {hosts && 'error' in hosts ? (
                <div data-frontdoor-line="hosts" className="flex flex-col gap-2 border-b border-[var(--border-1)] px-5 py-2 text-sm">
                    <div className="flex items-center gap-3">
                        <span>
                            Genie could not update the hosts file ({hosts.error}). Paste this block into <span className="font-mono">{frontDoor.hostsPath}</span> yourself, or try again.
                        </span>
                        <Button size="xs" type="button" className={button} onClick={() => onAction({ kind: 'hosting.syncHosts' })}>Try again</Button>
                    </div>
                    <pre data-manual-block className="overflow-auto rounded-md bg-[var(--bg-1)] p-2 font-mono text-xs">{hosts.manualBlock}</pre>
                </div>
            ) : null}
        </>
    );
}

/**
 * BACKGROUND PROCESSES (§6.6). The form adds one the person KEEPS: Genie starts it now, writes it
 * down, and brings it back on every launch until they stop it. A running process offers Stop and
 * Restart; a kept one that is not running offers Start and Remove (a stop is durable, so it stays
 * listed). A site's process is the site's: Remove is never offered for it here.
 *
 * Under a row with output, "Log" opens the end of it — the supervisor's tail, so it is still there
 * after the process exited or crashed, with Genie's own `[genie]` lines saying what happened. A
 * native `<details>` (as Workspace.tsx's plugin menu): its body is in the markup closed or open,
 * and its summary is not a button, so the row's actions stay exactly the row's.
 */
export function ProcessesPanel({ processes, workspaces, onAction, now, commandRun, processLog = null }: { processes: NonNullable<FeatureData['hosting']>['processes']; workspaces: readonly { id: string; path: string; name?: string | undefined }[]; onAction: SurfaceProps['onAction']; now?: number; commandRun?: { processId: string; workspaceId: string }; processLog?: ProcessLogOpen | null }) {
    const run = (a: RowAction) => { for (const act of a.acts) onAction(act); };
    const wsName = (id: string) => (workspaces.length > 0 ? workspaceLabel(workspaces, id) : null);
    // The Log the person opened (Tynn #860): shown while its process is still listed.
    const opened = processLog ? processes.find((p) => p.id === processLog.processId) ?? null : null;
    return (
        <div className="flex flex-col">
            <div className="flex items-center justify-end px-5 py-2">
                <AddProcessButton workspaces={workspaces} onAction={onAction} />
            </div>
            {commandRun && !processes.some((p) => p.commandRun && p.id === commandRun.processId && p.workspaceId === commandRun.workspaceId) ? (
                <p role="status" className="px-5 py-1 text-xs text-[var(--fg-3)]">This command is not in the current process history.</p>
            ) : null}
            {processes.length === 0 ? (
                <Empty>No background processes yet. Add one — a queue worker, a watcher, a dev server — and Genie keeps it running and brings it back after a restart.</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {processes.map((p) => {
                        const up = p.state === 'running' || p.state === 'restarting';
                        // Drawn in place (no hooks): the row's own buttons stay in this list's element tree.
                        if (p.schedule) return <Fragment key={p.id}>{scheduledRow({ p, up, now: now ?? Date.now(), onAction, workspace: wsName(p.workspaceId) })}</Fragment>;
                        const acts = processActions(p);
                        return (
                            <ProcessRow key={p.id} id={p.id} selected={Boolean(p.commandRun && commandRun?.processId === p.id && commandRun.workspaceId === p.workspaceId)}>
                                <span className="text-sm font-medium">{p.name}</span>
                                {wsName(p.workspaceId) ? <Badge variant="soft" size="sm">{wsName(p.workspaceId)}</Badge> : null}
                                <Badge variant="soft" size="sm">{p.state}</Badge>
                                {p.command ? <span className="min-w-0 truncate font-mono text-xs text-[var(--fg-4)]">{p.command}</span> : null}
                                {p.commandRun ? <CommandRunFacts process={p} now={now} /> : null}
                                {p.reason ? <span className="text-xs text-[var(--danger)]">{p.reason}</span> : null}
                                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                    {acts.primary.map((a) => <RowIconButton key={a.id} action={a} onRun={run} />)}
                                    <RowMenu items={acts.menu} onRun={run} />
                                    {logButton(p.id, onAction)}
                                </span>
                                {p.commandRun || (p.log && p.log.lines > 0) ? (
                                    <details data-process-log={p.id} className="basis-full">
                                        <summary className="cursor-pointer text-xs text-[var(--fg-3)]">
                                            {p.log && p.log.lines > 0 ? <>Log · last {p.log.lines} line{p.log.lines === 1 ? '' : 's'}{p.log.dropped > 0 ? ' (earlier output was cut)' : ''}</> : 'Log'}
                                        </summary>
                                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-1)] p-2 font-mono text-xs">{p.log?.text || (p.commandRun ? (up ? 'No output yet' : 'No output recorded') : '')}</pre>
                                    </details>
                                ) : null}
                            </ProcessRow>
                        );
                    })}
                </ul>
            )}
            {opened ? (
                <Modal open onClose={() => onAction({ kind: 'hosting.closeProcessLog' })} size="lg">
                    <Modal.Header>{opened.name}</Modal.Header>
                    <Modal.Body>
                        <ProcessLogView process={opened} log={processLog!} />
                    </Modal.Body>
                </Modal>
            ) : null}
        </div>
    );
}

/**
 * A process's Log (Tynn #860): opens its whole kept output, earlier Genies' included, and a scheduled task's runs. An icon
 * button like the row's others (Tynn #708: icons, named by their label), always last on the line.
 */
function logButton(processId: string, onAction: SurfaceProps['onAction']) {
    // Drawn in place (no component of its own): the row's buttons stay in the row's element tree, as scheduledRow's do.
    return <Button type="button" variant="circle" size="sm" icon="file-text" aria-label="Log" title="Log" data-open-log={processId} onClick={() => onAction({ kind: 'hosting.openProcessLog', processId })} />;
}

const RUN_WORD: Record<string, string> = { ok: 'Ran', failed: 'Failed', skipped: 'Skipped' };
const RUN_COLOR: Record<string, 'green' | 'red' | 'amber'> = { ok: 'green', failed: 'red', skipped: 'amber' };

/**
 * WHAT THE LOG SHOWS (Tynn #860; the owner: "anything that executes tasks needs to provide a log I can read"). A scheduled
 * task's runs first, newest first: how each ended, when it started and ended, WHY a run failed, and what a nudge sent.
 * Then the output Genie kept — across Genie restarts, with Genie's own line where one took over — or that there is none.
 */
export function ProcessLogView({ process: p, log }: { process: NonNullable<FeatureData['hosting']>['processes'][number]; log: ProcessLogOpen }) {
    const runs = p.schedule?.runs ?? [];
    const nudge = p.schedule?.kind === 'agent-nudge';
    return (
        <div data-process-log-view={p.id} className="flex flex-col gap-3 text-xs">
            {p.schedule ? (
                runs.length > 0 ? (
                    <ol data-scheduled-runs className="flex flex-col gap-1.5">
                        {runs.map((r) => (
                            <li key={`${r.at}:${r.status}`} data-scheduled-run={r.status} className="flex flex-wrap items-baseline gap-2">
                                <Badge color={RUN_COLOR[r.status] ?? 'zinc'} variant="soft" size="sm">{RUN_WORD[r.status] ?? r.status}</Badge>
                                <span className="text-[var(--fg-3)]">{new Date(r.at).toLocaleString()} → {new Date(r.endedAt).toLocaleTimeString()}</span>
                                {r.reason ? <span data-scheduled-run-reason className="basis-full text-[var(--danger)]">{r.reason}</span> : null}
                                {r.sent ? <span className="basis-full text-[var(--fg-3)]">Sent: <span className="text-[var(--fg-2)]">{r.sent}</span></span> : null}
                            </li>
                        ))}
                    </ol>
                ) : <p className="text-[var(--fg-3)]">No runs yet.</p>
            ) : null}
            {log.dropped > 0 ? <p className="text-[var(--fg-4)]">{log.dropped} earlier {log.dropped === 1 ? 'line was' : 'lines were'} cut</p> : null}
            {log.text !== '' || !nudge ? (
                <pre data-process-log-text className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-1)] p-2 font-mono">{log.text === '' ? 'No output' : log.text}</pre>
            ) : null}
        </div>
    );
}

/** "Add process": a button that opens the labelled form in a modal. The only hook in the Processes tab, kept out of the panel. */
function AddProcessButton({ workspaces, onAction }: { workspaces: readonly { id: string; path: string; name?: string | undefined }[]; onAction: SurfaceProps['onAction'] }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button type="button" size="sm" icon="plus" data-action="add-process" disabled={workspaces.length === 0} onClick={() => setOpen(true)}>Add process</Button>
            <Modal open={open} onClose={() => setOpen(false)} size="md">
                <Modal.Header>Add process</Modal.Header>
                <Modal.Body>
                    <AddProcessForm workspaces={workspaces} onCancel={() => setOpen(false)} onSubmit={(a) => { onAction(a); setOpen(false); }} />
                </Modal.Body>
            </Modal>
        </>
    );
}

/** Focus changes only with the selected target, so live output never steals focus from the person's controls. */
function ProcessRow({ id, selected, children }: { id: string; selected: boolean; children: React.ReactNode }) {
    const ref = useRef<HTMLLIElement>(null);
    useEffect(() => {
        if (!selected) return;
        const row = ref.current;
        const log = row?.querySelector<HTMLDetailsElement>('[data-process-log]');
        if (!row || !log) return;
        log.open = true;
        row.focus({ preventScroll: true });
        row.scrollIntoView?.({ block: 'nearest' });
    }, [selected]);
    return <li ref={ref} data-process={id} tabIndex={selected ? -1 : undefined} className="flex flex-wrap items-center gap-3 px-5 py-2">{children}</li>;
}

/** Only this small clock ticks; the process list's forms, buttons and log DOM remain mounted in place. */
function CommandRunFacts({ process: p, now }: { process: NonNullable<FeatureData['hosting']>['processes'][number]; now: number | undefined }) {
    const [clock, setClock] = useState(() => Date.now());
    const up = p.state === 'running' || p.state === 'restarting';
    useEffect(() => {
        if (!up || now !== undefined) return;
        setClock(Date.now());
        const timer = setInterval(() => setClock(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [up, now]);
    const start = p.startedAt ?? (up ? p.since : undefined);
    const end = up ? (now ?? clock) : p.since;
    const facts: string[] = [];
    if (start !== undefined && Number.isFinite(start) && Number.isFinite(end)) {
        const seconds = Math.floor(Math.max(0, end - start) / 1_000);
        const duration = seconds >= 3_600 ? `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m ${seconds % 60}s`
            : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
        facts.push(`${up ? 'Elapsed' : 'Duration'} ${duration}`);
    }
    if (!up && p.exitCode !== null) facts.push(`exit ${p.exitCode}`);
    return facts.length > 0 ? <span className="text-xs text-[var(--fg-3)]">{facts.join(' · ')}</span> : null;
}

/**
 * A SCHEDULED TASK'S ROW (genie#1204) — Genie 1's Processes card for one (lib/process-manager.ts `processCard` at
 * v0.7.0-beta.342): the "scheduled" badge; "Running now", "Scheduled" or "Paused — not firing"; the schedule in words, the
 * next and the last run; for a nudge, whom it prompts and with what. Run now, Pause schedule / Enable schedule, Remove.
 */
function scheduledRow({ p, up, now, onAction, workspace = null }: { p: NonNullable<FeatureData['hosting']>['processes'][number]; up: boolean; now: number; onAction: SurfaceProps['onAction']; workspace?: string | null }) {
    const s = p.schedule!;
    const nudge = s.kind === 'agent-nudge';
    const status = up ? 'Running now' : s.enabled ? 'Scheduled' : 'Paused — not firing';
    // Why the last run failed or was skipped, on the row (Tynn #860); its Log has every run.
    const failure = lastFailure(s);
    const acts = scheduledActions(p);
    const run = (a: RowAction) => { for (const act of a.acts) onAction(act); };
    return (
        <li data-process={p.id} data-process-scheduled={s.enabled ? 'enabled' : 'paused'} className="flex flex-wrap items-center gap-3 px-5 py-2">
            <span className="text-sm font-medium">{p.name}</span>
            {workspace ? <Badge variant="soft" size="sm">{workspace}</Badge> : null}
            <Badge variant="soft" size="sm">scheduled</Badge>
            <span className="text-xs text-[var(--fg-2)]">{status}</span>
            {!nudge && p.command ? <span className="min-w-0 truncate font-mono text-xs text-[var(--fg-4)]">{p.command}</span> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {acts.primary.map((a) => <RowIconButton key={a.id} action={a} onRun={run} />)}
                <RowMenu items={acts.menu} onRun={run} />
                {logButton(p.id, onAction)}
            </span>
            <span className="basis-full text-xs text-[var(--fg-3)]">
                {describeSchedule(s.cron)} · Next run: {formatNextRun(s.nextRunAt, now)} · Last run: {formatLastRun(s.lastRunAt, s.lastRunStatus, now)}
            </span>
            {failure ? <span data-run-reason className="basis-full text-xs text-[var(--danger)]">{failure}</span> : null}
            {nudge ? (
                <span className="basis-full text-xs text-[var(--fg-3)]">Each run nudges {s.agent} with: <span className="text-[var(--fg-2)]">{s.prompt}</span></span>
            ) : null}
            {p.log && p.log.lines > 0 ? (
                <details data-process-log={p.id} className="basis-full">
                    <summary className="cursor-pointer text-xs text-[var(--fg-3)]">Log · last {p.log.lines} line{p.log.lines === 1 ? '' : 's'}{p.log.dropped > 0 ? ' (earlier output was cut)' : ''}</summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-1)] p-2 font-mono text-xs">{p.log.text}</pre>
                </details>
            ) : null}
        </li>
    );
}

function sameScope(a: ServiceInstance, b: ServiceInstance): boolean {
    return a.scope.kind === b.scope.kind && (a.scope.kind === 'shared' || (b.scope.kind === 'dedicated' && a.scope.workspaceId === b.scope.workspaceId));
}

/** Mailpit's web inbox on its own loopback port, when the engine publishes it (Genie 1's `ui` surface). */
/** Mailpit's web inbox at its .gen name (core/mailpit-name.ts) — what the Genie browser opens. */
export function inboxUrlOf(i: ServiceInstance): string | null {
    return mailpitInboxUrl(i);
}

/**
 * "Remove and delete data", confirmed ON THE ROW (H6): it says exactly what is deleted — the volume and whose data is
 * in it — before the button that does it. When another workspace keeps data in the engine there is NO delete button,
 * only why (core/service-tenancy.ts, the same verdict main enforces). It acts for the engine's sole holder.
 */
export function DeleteDataConfirm({ instance, workspaces, onAction, onCancel }: { instance: ServiceInstance; workspaces: readonly { id: string; path: string; name?: string | undefined }[]; onAction: SurfaceProps['onAction']; onCancel: () => void }) {
    const holder = soleHolderOf(instance);
    const verdict = deleteDataVerdict(instance, holder, (id) => workspaceLabel(workspaces, id));
    return (
        <div data-delete-confirm={instance.id} data-delete-allowed={verdict.allowed ? 'true' : 'false'} className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--danger)] px-3 py-2 text-sm">
            {verdict.allowed ? (
                <>
                    <span>Removes {instance.engine} {instance.version} and deletes {verdict.deletes}. This cannot be undone.</span>
                    <Button size="xs"
                        type="button"
                        className="ml-auto rounded-lg bg-[var(--danger)] px-2.5 py-1 text-[13px] text-white"
                        onClick={() => onAction({ kind: 'services.remove', serviceId: instance.id, deleteData: true, ...(holder ? { workspaceId: holder } : {}) })}
                    >
                        Delete the data
                    </Button>
                </>
            ) : (
                <span data-delete-refused>{verdict.reason}</span>
            )}
            <Button size="xs" type="button" className={verdict.allowed ? 'text-[13px]' : 'ml-auto text-[13px]'} onClick={onCancel}>Keep it</Button>
        </div>
    );
}

/**
 * SERVICE ENGINES (§6.6). Each row: engine and version, scope, status as Docker reported it, the
 * loopback port. The active version is marked; another version offers "Make active" with the data
 * warning ON THE ROW, before the click — a switch is never a surprise. Remove keeps the data volume;
 * "Remove and delete data…" opens a confirmation that names what is deleted, or why it may not be.
 * "Logs" reads the end of the engine's own output; a Mailpit row opens its web inbox in Genie's browser.
 */
function ServicesPanel({ services, workspaces, onAction, onNavigate }: { services: FeatureData['services']; workspaces: readonly { id: string; path: string; name?: string | undefined }[]; onAction: SurfaceProps['onAction']; onNavigate: SurfaceProps['onNavigate'] }) {
    const [confirming, setConfirming] = useState<string | null>(null);
    if (services === null) return <Skeletons />;
    const logs = services.logs ?? null;
    return (
        <div className="flex flex-col">
            <form
                className="flex items-center gap-2 px-5 py-2"
                onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'services.add', workspaceId: w.id }); }}
            >
                <WorkspacePick workspaces={workspaces} name="workspace" />
                <Button size="xs" type="submit" disabled={workspaces.length === 0} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                    Add an engine
                </Button>
            </form>
            {services.instances.length === 0 ? (
                <Empty>No service engines yet. Add an engine — Postgres, MySQL, MariaDB, Redis, Mongo, Mailpit, Meilisearch, S3, or an image of your own — dedicated to a workspace or shared by the workstation.</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {services.instances.map(({ instance: i, status, note }) => {
                        const activeSibling = services.instances.find((o) => o.instance.engine === i.engine && o.instance.active && sameScope(o.instance, i))?.instance;
                        const warning = !i.active && activeSibling ? switchActiveWarning({ engine: i.engine, from: activeSibling.version, to: i.version }) : null;
                        const scope = i.scope;
                        const inbox = inboxUrlOf(i);
                        const myLog = logs?.serviceId === i.id ? logs : null;
                        const acts = serviceActions(i, status, { warning: warning !== null, logsOpen: myLog !== null });
                        // Navigate first (Open inbox shows Genie's browser), then send; "delete data" opens ITS OWN confirmation on the row.
                        const run = (a: RowAction) => {
                            if (a.confirm === 'inline') { setConfirming(confirming === i.id ? null : i.id); return; }
                            if (a.navigate) onNavigate(a.navigate);
                            for (const act of a.acts) onAction(act);
                        };
                        return (
                            <li key={i.id} data-service={i.id} data-service-status={status} data-active={i.active ? 'true' : 'false'} className="flex flex-col gap-1 px-5 py-2">
                                <div className="flex items-center gap-3">
                                    <span className="text-sm font-medium">{engineName(i)}</span>
                                    <Badge variant="soft" size="sm">{scope.kind === 'shared' ? 'shared' : workspaceLabel(workspaces, scope.workspaceId)}</Badge>
                                    <Badge variant="soft" size="sm">{status === 'docker-not-running' ? 'Docker is not running' : status === 'unknown' ? 'state unknown' : status}</Badge>
                                    {i.active ? <Badge variant="soft" size="sm">active</Badge> : null}
                                    <span className="font-mono text-xs text-[var(--fg-4)]">127.0.0.1:{i.publishedPort}</span>
                                    {i.engine === 'custom' && i.image ? <span className="min-w-0 truncate font-mono text-xs text-[var(--fg-4)]">{i.image}</span> : null}
                                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                        {acts.primary.map((a) => <RowIconButton key={a.id} action={a} onRun={run} {...(a.id === 'open-inbox' ? { 'data-open-inbox': inbox ?? '' } : {})} />)}
                                        <RowMenu items={acts.menu} onRun={run} />
                                    </span>
                                </div>
                                {warning ? <p className="text-xs text-[var(--warning)]">{warning}</p> : null}
                                {(status === 'docker-not-running' || status === 'unknown') && note ? <p className="text-xs text-[var(--warning)]">{note}</p> : null}
                                {confirming === i.id ? <DeleteDataConfirm instance={i} workspaces={workspaces} onAction={onAction} onCancel={() => setConfirming(null)} /> : null}
                                {services.updating?.serviceId === i.id ? (
                                    <div data-service-update-confirm={i.id} className="flex flex-col gap-2 rounded-md border border-[var(--border-1)] p-3 text-sm">
                                        <p>{services.updating.note}</p>
                                        {services.updating.dependents.length > 0 ? <p className="text-[var(--warning)]">This interrupts: {services.updating.dependents.join('; ')}.</p> : null}
                                        <div className="flex gap-3">
                                            <Button size="xs" type="button" onClick={() => onAction({ kind: 'services.update', serviceId: i.id, consent: true, confirmed: true })}>{services.updating.dependents.length > 0 ? 'Update and interrupt' : 'Pull and update'}</Button>
                                            <Button size="xs" type="button" onClick={() => onAction({ kind: 'services.cancelUpdate' })}>Cancel</Button>
                                        </div>
                                    </div>
                                ) : null}
                                {myLog ? (
                                    <div data-service-log={i.id} className="flex flex-col gap-1">
                                        <div className="flex items-center gap-3 text-xs text-[var(--fg-3)]">
                                            <span>Logs · the last {myLog.tail} lines Docker kept for this engine</span>
                                            <Button size="xs" type="button" className="ml-auto text-[13px]" onClick={() => onAction({ kind: 'services.hideLogs' })}>Hide logs</Button>
                                        </div>
                                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-1)] p-2 font-mono text-xs">{myLog.text === '' ? 'The engine has written nothing yet.' : myLog.text}</pre>
                                    </div>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
            <EngineChoices instances={services.instances.map((v) => v.instance)} workspaces={workspaces} onAction={onAction} />
        </div>
    );
}

/**
 * WHICH ENGINE EACH WORKSPACE USES, per kind — wherever there is a choice to see: more than one candidate, or a shared one
 * (Genie 1's included) a workspace could detach from. The same rule main emits env by (core/services.ts `chooseEngines`),
 * so what this says a workspace uses is what its processes get. "Use" picks one; "Detach" stops a shared one giving the
 * workspace its connection, keeping its database and data; a detached one offers "Attach" (the same `use`).
 */
export function EngineChoices({ instances, workspaces, onAction }: { instances: readonly ServiceInstance[]; workspaces: readonly { id: string; path: string; name?: string | undefined }[]; onAction: SurfaceProps['onAction'] }) {
    const label = (i: ServiceInstance) => `${i.engine === 'custom' ? `custom ${i.version}` : `${i.engine}${i.variant ? ` (${i.variant})` : ''} ${i.version}`}${i.scope.kind === 'shared' ? ' · shared' : ''}`;
    const rows = workspaces.flatMap((w) => {
        const visible = instances.filter((i) => (i.scope.kind === 'dedicated' ? i.scope.workspaceId === w.id : true));
        return chooseEngines(visible, w.id)
            .filter((c) => c.candidates.length > 1 || c.candidates.some((x) => !x.own))
            .map((c) => ({ workspace: w, choice: c }));
    });
    if (rows.length === 0) return null;
    const run = (a: RowAction) => { for (const act of a.acts) onAction(act); };
    return (
        <div data-engine-choices className="flex flex-col gap-1 border-t border-[var(--border-1)] px-5 py-3">
            <span className="text-sm font-medium">In use</span>
            <Table>
                <Table.Head>
                    <Table.Row>
                        <Table.Column label="Workspace" className="px-2 py-1.5 text-xs" />
                        <Table.Column label="Service" className="px-2 py-1.5 text-xs" />
                        <Table.Column label="Version" className="px-2 py-1.5 text-xs" />
                        <Table.Column label="" aria-label="Actions" className="w-10 px-2 py-1.5" />
                    </Table.Row>
                </Table.Head>
                <Table.Body>
                    {rows.map(({ workspace: w, choice: c }) => (
                        <Table.Row key={`${w.id}:${c.kind}`} data-engine-choice={`${w.id}:${c.kind}`} data-chosen={c.chosen?.id ?? ''}>
                            <Table.Cell className="px-2 py-1.5 text-sm">{workspaceLabel(workspaces, w.id)}</Table.Cell>
                            <Table.Cell className="px-2 py-1.5 text-sm">{c.kind}</Table.Cell>
                            <Table.Cell className="px-2 py-1.5 text-sm">
                                <span className="inline-flex items-center gap-2">
                                    {c.chosen ? `${c.chosen.variant ? `${c.chosen.variant} ` : ''}${c.chosen.version}` : 'none'}
                                    {c.chosen && c.chosen.scope.kind === 'shared' ? <Badge variant="soft" size="sm">shared</Badge> : null}
                                </span>
                            </Table.Cell>
                            <Table.Cell className="px-2 py-1.5 text-right"><RowMenu items={engineChoiceActions(w.id, c, label)} onRun={run} /></Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
        </div>
    );
}

type ToolchainData = NonNullable<FeatureData['toolchain']>;

/**
 * ONE TOOL ROW'S UPDATE ACTIONS (genie#1306; the owner: "make what I can click on obvious, and make it obvious that
 * something is happening"). Real buttons, each sending the update for the version it names: a language's PATCH first and
 * primary — a security notice's fix (8.4.24 → 8.4.27) — and another line as a separate, secondary button (8.5.12); any
 * other tool's "Update to <latest>". While its update runs the row shows the step with a spinner and every button is
 * off; it ends updated (the new version), or failed — the reason, and Retry. Hook-free: what it renders is what is tested.
 */
/**
 * A BROKEN AGENT CLI'S ONE ACTION (Tynn #698): Repair, Genie running the vendor's installer itself. While it runs the row
 * shows its step on the busy button; it ends repaired (the row re-checked) or failed, the reason on the row and Repair again.
 */
export function CliRepairAction({ t, busy, updating, onAction }: { t: ToolStatus; busy: boolean; updating?: ToolchainData['updating'] | null; onAction: SurfaceProps['onAction'] }) {
    if (updating && updating.tool === t.tool) {
        return (
            <span data-tool-updating={t.tool} className="ml-auto flex items-center gap-2">
                <Button type="button" size="sm" color="blue" loading disabled data-action="toolchain-repair-cli">{updating.step}</Button>
            </span>
        );
    }
    return (
        <Button type="button" size="sm" color="red" className="ml-auto" disabled={busy || (updating ?? null) !== null} data-action="toolchain-repair-cli" onClick={() => onAction({ kind: 'toolchain.repairCli', tool: t.tool })}>
            Repair
        </Button>
    );
}

export function ToolUpdateActions({ t, busy, updating, updated, refusal, onAction }: { t: ToolStatus; busy: boolean; updating?: ToolchainData['updating'] | null; updated?: ToolchainData['updated'] | null; refusal?: ToolchainRefusal | null; onAction: SurfaceProps['onAction'] }) {
    const update = (version?: string) => onAction({ kind: 'toolchain.update', tool: t.tool, ...(version ? { version } : {}) });
    if (updating && updating.tool === t.tool) {
        return (
            <span data-tool-updating={t.tool} className="ml-auto flex items-center gap-2">
                <Button type="button" size="sm" color="blue" loading disabled data-action="toolchain-update" {...(updating.version ? { 'data-version': updating.version } : {})}>{updating.step}</Button>
            </span>
        );
    }
    const off = busy || (updating ?? null) !== null;
    // A language Genie installs itself: its patch, then another line. Anything else: what its own updater knows of.
    const language = t.patch !== undefined || t.upgrade !== undefined;
    const primary = language ? (t.patch ?? t.upgrade) : (t.tone === 'update-available' || t.tone === 'security-update') && t.latest ? t.latest : undefined;
    const secondary = language && t.patch !== undefined ? t.upgrade : undefined;
    const bare = !language && primary === undefined && t.tone === 'unknown' && t.installed !== null;
    return (
        <>
            {updated && updated.tool === t.tool ? (
                <span data-tool-updated={t.tool} className="rounded-md bg-[var(--success,#16a34a)] px-1.5 py-0.5 text-xs font-medium text-white">✓ {updated.version}</span>
            ) : null}
            {primary !== undefined ? (
                <Button type="button" size="sm" color={t.tone === 'security-update' ? 'red' : 'blue'} className="ml-auto" disabled={off} data-action="toolchain-update" data-version={primary} onClick={() => update(primary)}>
                    Update to {primary}
                </Button>
            ) : bare ? (
                <Button type="button" size="sm" color="blue" className="ml-auto" disabled={off} data-action="toolchain-update" onClick={() => update()}>Update</Button>
            ) : null}
            {secondary !== undefined ? (
                <Button type="button" size="sm" variant="ghost" disabled={off} data-action="toolchain-upgrade" data-version={secondary} onClick={() => update(secondary)}>
                    {secondary}
                </Button>
            ) : null}
            {refusal ? (
                <span data-tool-refusal={t.tool} className="flex basis-full items-center gap-2 text-xs text-[var(--danger)]">
                    <span>{refusal.reason}</span>
                    {refusal.retry !== undefined ? (
                        <Button type="button" size="xs" disabled={off} data-action="toolchain-retry" data-version={refusal.retry} onClick={() => update(refusal.retry)}>Retry</Button>
                    ) : null}
                </span>
            ) : null}
        </>
    );
}

/**
 * WHAT RUNS ON THE OLD VERSION (genie#1306): the count, the names behind a toggle — not a wall of text — and one choice:
 * update and restart them (first, the default), or update only. Hook-free, like the row's actions.
 */
export function ToolchainUpdateWarning({ warning, busy, onAction }: { warning: NonNullable<ToolchainData['warning']>; busy: boolean; onAction: SurfaceProps['onAction'] }) {
    const label = ({ php: 'PHP', node: 'Node', python: 'Python', go: 'Go', docker: 'Docker' } as Record<string, string>)[warning.tool] ?? warning.tool;
    const go = (restart: boolean) => onAction({ kind: 'toolchain.update', tool: warning.tool, ...(warning.version ? { version: warning.version } : {}), confirmed: true, restart });
    const n = warning.affected.length;
    return (
        <div data-toolchain-warning={warning.tool} className="flex flex-wrap items-center gap-3 border-b border-[var(--border-1)] px-5 py-2 text-sm">
            <details className="min-w-0">
                <summary className="cursor-pointer text-[var(--warning)]">{warning.tool === 'docker' ? `Stops ${n} running` : `${n} running on ${label}`}</summary>
                <ul className="mt-1 list-disc pl-5 text-xs text-[var(--fg-2)]">
                    {warning.affected.map((a) => <li key={a}>{a}</li>)}
                </ul>
            </details>
            <span className="ml-auto flex shrink-0 gap-2">
                <Button type="button" size="sm" color="blue" disabled={busy} data-action="toolchain-update-restart" onClick={() => go(true)}>{warning.tool === 'docker' ? 'Update anyway' : 'Update and restart'}</Button>
                {warning.tool === 'docker' ? null : <Button type="button" size="sm" variant="ghost" disabled={busy} data-action="toolchain-update-only" onClick={() => go(false)}>Update only</Button>}
            </span>
        </div>
    );
}

/** One row's state in a "Check for updates" run (Tynn #714): an icon and a word, the reason when it failed. */
export function CheckStateMark({ tool, check }: { tool: string; check: ToolCheckState }) {
    const look = {
        waiting: { icon: 'circle', word: 'Waiting', tone: 'text-[var(--fg-4)]' },
        checking: { icon: 'loader-circle', word: 'Checking', tone: 'text-[var(--fg-3)]' },
        'up-to-date': { icon: 'circle-check', word: 'Up to date', tone: 'text-[var(--success)]' },
        'update-available': { icon: 'circle-arrow-up', word: 'Update available', tone: 'text-[var(--warning)]' },
        failed: { icon: 'circle-x', word: 'Failed', tone: 'text-[var(--danger)]' },
    }[check.state];
    return (
        <span data-check-state={check.state} data-check-tool={tool} className={`inline-flex items-center gap-1 text-xs ${look.tone}`}>
            <Icon name={look.icon} size="xs" {...(check.state === 'checking' ? { className: 'animate-spin' } : {})} />
            {look.word}{check.state === 'failed' ? <span className="text-[var(--danger)]">: {check.reason}</span> : null}
        </span>
    );
}

/**
 * THE CHECK'S CONTROLS (Tynn #714): "Check for updates" re-checks every row one at a time and installs nothing; while it
 * runs the same place says Stop; and the last-checked time sits beside it. Opening the page never starts this.
 */
export function ToolchainCheckBar({ tc, busy, onAction }: { tc: ToolchainData | null; busy: boolean; onAction: SurfaceProps['onAction'] }) {
    const running = tc?.checkRun?.running === true;
    const at = tc?.checkedAt ?? null;
    return (
        <>
            <span data-toolchain-checked={at ?? ''} className="ml-auto text-xs text-[var(--fg-3)]" {...(at !== null ? { title: new Date(at).toLocaleString() } : {})}>
                {at === null ? 'Not checked yet' : `Checked ${agoText(at, Date.now())}`}
            </span>
            {running ? (
                <Button size="xs" type="button" color="red" data-action="toolchain-check-stop" onClick={() => onAction({ kind: 'toolchain.stopCheck' })}>
                    <Icon name="square" size="xs" />Stop
                </Button>
            ) : (
                <Button size="xs" type="button" data-action="toolchain-check-updates" disabled={busy} onClick={() => onAction({ kind: 'toolchain.checkUpdates' })}>
                    <Icon name="refresh-cw" size="xs" />Check for updates
                </Button>
            )}
        </>
    );
}

/**
 * THE TOOLCHAIN (Tynn #962 — the redesign the owner approved on the ArtBoard, 2026-11-20; mockup
 * .ai/sandbox/958-toolchain-mockup.html). A problems strip with one button per problem, logo cards grouped by type with
 * ONE primary action each, progress drawn on the card it is for while the rest of the page stays usable, a side panel per
 * tool, and an activity feed. No raw shell command anywhere: an install says "asks once" or "no password", and the
 * command it runs is its tooltip. UI only: every control sends an action main already handles; the model is
 * renderer/toolchain-view.ts.
 */
export function ToolchainSurface({ data, onAction: act, selected: initial }: SurfaceProps & { selected?: string | undefined }) {
    const tc = data.toolchain;
    const busy = tc?.busy ?? null;
    // The click shows at once (genie#1306): an update's card says "Starting" until main's own step arrives, and is cleared
    // by the next snapshot either way — an update never looks like nothing happened.
    const [pending, setPending] = useState<{ tool: string; version?: string } | null>(null);
    useEffect(() => { setPending(null); }, [tc]);
    // Main reports every install through ONE busy line; the card it is drawn on is the one the person clicked.
    const [inFlight, setInFlight] = useState<{ card: string; at: number } | null>(null);
    const [chosen, setChosen] = useState<string | null>(initial ?? null);
    const [now, setNow] = useState(() => Date.now());
    const onAction: SurfaceProps['onAction'] = (action) => {
        if (action.kind === 'toolchain.update') setPending({ tool: action.tool, ...(action.version ? { version: action.version } : {}) });
        const card = cardOfAction(action);
        if (card !== null && action.kind !== 'toolchain.setDefault' && action.kind !== 'toolchain.login') setInFlight({ card, at: Date.now() });
        return act(action);
    };
    const updating = tc?.updating ?? (pending ? { ...pending, step: 'Starting' } : null);
    const running = busy !== null || updating !== null;
    useEffect(() => { if (tc && tc.busy === undefined && tc.updating === undefined && pending === null) setInFlight(null); }, [tc, pending]);
    useEffect(() => {
        if (!running) return undefined;
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(tick);
    }, [running]);
    // First run: the surface has never been scanned — scan once on open instead of drawing skeletons until a click.
    const asked = useRef(false);
    useEffect(() => {
        if (tc === null && !asked.current) {
            asked.current = true;
            onAction({ kind: 'toolchain.check' });
        }
    }, [tc, onAction]);
    const servicesWaiting = (data.services?.instances ?? []).filter((s) => s.status === 'docker-not-running').length;
    const groups = tc ? toolchainCards(tc) : [];
    const problems = tc ? toolchainProblems(tc, servicesWaiting) : [];
    const fixable = problems.flatMap((p) => (p.action ? [p.action] : []));
    // "FIX N PROBLEMS": the strip's actions one at a time, each after main has answered the last (toolchain-view nextFix).
    const [fix, setFix] = useState<{ queue: FeatureAction[]; waiting: boolean; refusals: number } | null>(null);
    useEffect(() => {
        if (!fix || fix.waiting) return;
        const { send, rest } = nextFix(fix.queue, tc, fix.refusals);
        if (!send) {
            if (rest.length === 0) setFix(null);
            return;
        }
        setFix({ ...fix, queue: rest, waiting: true });
        void Promise.resolve(onAction(send)).finally(() => setFix((f) => (f ? { ...f, waiting: false } : f)));
        // onAction is a fresh closure every render; the queue advances on the snapshot, not on it.
    }, [fix, tc]);
    const cards = groups.flatMap((g) => g.cards);
    const selectedKey = chosen !== null && cards.some((c) => c.key === chosen) ? chosen : defaultSelection(groups, problems);
    const selectedCard = cards.find((c) => c.key === selectedKey) ?? null;
    const checkRows = tc?.checkRun?.rows ?? {};
    // A refused or failed action, drawn on the card it was for (who or what is busy, verbatim); a language version's goes to
    // its panel, and one for a tool with no card (a prerequisite such as vcredist) is said above the cards, never dropped.
    const refusals = tc?.refusals ?? [];
    const toolRefusal = (tool: string) => refusals.find((r) => r.tool === tool && r.version === undefined) ?? null;
    const rowless = refusals.filter((r) => r.version === undefined && !(tc?.tools ?? []).some((t) => t.tool === r.tool) && r.tool !== 'machine-path');
    const progressOf = (key: string): { step: string; elapsed: string | null } | null => {
        if (updating && cardKeyOfTool(updating.tool) === key) return { step: updating.step, elapsed: inFlight?.card === key ? formatElapsed(now - inFlight.at) : null };
        if (busy !== null && inFlight?.card === key) return { step: busy, elapsed: formatElapsed(now - inFlight.at) };
        return null;
    };
    const elevated = Object.values(tc?.installs ?? {}).some((p) => 'label' in p && p.elevated);
    const tally = toolchainTally(groups, problems);
    return (
        <div data-surface="toolchain" className="flex h-full min-h-0 flex-col">
            <Header title="Toolchain">
                {elevated ? (
                    <span data-toolchain-asks="" title="Installs and updates run as you; only the system package manager asks for your password, once per install" className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--border-1)] bg-[var(--bg-2)] px-2.5 text-xs text-[var(--fg-2)]">
                        <Icon name="lock" size="xs" />Asks once per system install
                    </span>
                ) : null}
                <ToolchainCheckBar tc={tc} busy={busy !== null} onAction={onAction} />
                <Button size="xs" type="button" variant="ghost" disabled={busy !== null} onClick={() => onAction({ kind: 'toolchain.repair' })}>
                    <Icon name="stethoscope" size="xs" />Check and repair
                </Button>
                {fixable.length > 0 ? (
                    <Button size="sm" type="button" color="blue" data-action="toolchain-fix-all" disabled={running || fix !== null} loading={fix !== null} onClick={() => setFix({ queue: fixable, waiting: false, refusals: refusals.length })}>
                        <Icon name="wrench" size="xs" />Fix {fixable.length} {fixable.length === 1 ? 'problem' : 'problems'}
                    </Button>
                ) : null}
            </Header>
            {tc === null ? (
                <Skeletons rows={6} />
            ) : (
                <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-1">
                    <div className="min-h-0 overflow-y-auto pb-4">
                        {tc.warning ? <ToolchainUpdateWarning warning={tc.warning} busy={running} onAction={onAction} /> : null}
                        {rowless.map((r) => (
                            <p key={r.tool} data-tool-refusal={r.tool} className="px-6 pt-3 text-sm text-[var(--danger)]">{r.reason}</p>
                        ))}
                        <ToolchainTallies tally={tally} />
                        {problems.length > 0 ? <ProblemsStrip problems={problems} busy={running} onAction={onAction} onOpen={setChosen} /> : null}
                        {tc.machinePath ? <div className="mx-6 mt-3 overflow-hidden rounded-xl border border-[var(--border-1)]"><MachinePathCard mp={tc.machinePath} busy={busy !== null} onAction={onAction} refusal={refusals.find((r) => r.tool === 'machine-path')?.reason ?? null} /></div> : null}
                        {groups.map((g) => (
                            <section key={g.group} data-card-group={g.group} className="px-6">
                                <h3 className="mb-2 mt-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-3)]">
                                    {g.label}<span aria-hidden="true" className="h-px flex-1 bg-[var(--border-1)]" />
                                </h3>
                                <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5">
                                    {g.cards.map((c) => (
                                        <ToolCardView
                                            key={c.key}
                                            card={c}
                                            selected={c.key === selectedKey}
                                            busy={running}
                                            updating={updating}
                                            updated={tc.updated ?? null}
                                            refusal={c.tool ? toolRefusal(c.tool.tool) : null}
                                            check={c.tool ? checkRows[c.tool.tool] : undefined}
                                            install={c.tool ? tc.installs?.[c.tool.tool] : undefined}
                                            progress={progressOf(c.key)}
                                            onSelect={() => setChosen(c.key)}
                                            onAction={onAction}
                                        />
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </div>
                    <aside className="flex min-h-0 flex-col overflow-y-auto border-t border-[var(--border-1)] bg-[var(--bg-1)] lg:border-l lg:border-t-0">
                        {selectedCard ? <ToolPanel card={selectedCard} tc={tc} busy={busy !== null} check={selectedCard.lang ? checkRows[selectedCard.lang] : undefined} onAction={onAction} onClose={() => setChosen(null)} /> : null}
                        <ActivityFeed tc={tc} />
                    </aside>
                </div>
            )}
        </div>
    );
}

/** The three tiles: ready, updates (and how many of them are security fixes), and what needs the person. */
function ToolchainTallies({ tally }: { tally: ReturnType<typeof toolchainTally> }) {
    const tile = (id: string, n: number, word: string, dot: string) => (
        <div data-tally={id} className="flex items-center gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] px-3.5 py-3">
            <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${dot}`} />
            <div className="leading-tight"><b className="text-xl font-semibold">{n}</b><br /><span className="text-xs text-[var(--fg-2)]">{word}</span></div>
        </div>
    );
    return (
        <div data-toolchain-tallies="" className="grid grid-cols-3 gap-3 px-6 pt-4">
            {tile('ready', tally.ready, 'ready', 'bg-[var(--success)]')}
            {tile('updates', tally.updates, tally.security > 0 ? `updates · ${tally.security} security` : 'updates', 'bg-[var(--warning)]')}
            {tile('need-you', tally.needYou, 'need you', 'bg-[var(--danger)]')}
        </div>
    );
}

/** THE PROBLEMS STRIP: each problem, why it matters, and its ONE button (or, with nothing one click fixes, its panel). */
export function ProblemsStrip({ problems, busy, onAction, onOpen }: { problems: readonly ToolchainProblem[]; busy: boolean; onAction: SurfaceProps['onAction']; onOpen: (card: string) => void }) {
    return (
        <ul data-toolchain-problems={problems.length} className="mx-6 mt-3 divide-y divide-[var(--border-1)] overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger)_6%,var(--bg-1))]">
            {problems.map((p) => (
                <li key={p.key} data-problem={p.key} className="flex items-center gap-3 px-3.5 py-2.5">
                    <ToolLogo tool={p.card} />
                    <div className="min-w-0">
                        <b className="text-sm font-semibold">{p.title}</b>
                        {p.why ? <div className="text-xs text-[var(--fg-2)]">{p.why}</div> : null}
                    </div>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                        {p.note ? <span className="font-mono text-[11px] text-[var(--fg-3)]">{p.note}</span> : null}
                        {p.action ? (
                            <Button type="button" size="sm" color="red" data-problem-action={p.key} disabled={busy} onClick={() => onAction(p.action!)}>{p.label}</Button>
                        ) : (
                            <Button type="button" size="sm" variant="ghost" data-problem-action={p.key} onClick={() => onOpen(p.card)}>{p.label}</Button>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** A card's status in its corner: an icon, named for a screen reader and on hover. Quiet and missing cards have none. */
function CardStatus({ card }: { card: ToolCard }) {
    const word = card.tool?.signedOut ? 'Not signed in' : card.tool ? toneLabel(card.tool.tone) : null;
    const look = {
        ok: { icon: 'check', tone: 'bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]', word: word ?? 'Up to date' },
        update: { icon: 'arrow-up', tone: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]', word: word ?? 'Update available' },
        problem: { icon: 'circle-alert', tone: 'bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-[var(--danger)]', word: word ?? 'Needs you' },
    }[card.state as 'ok' | 'update' | 'problem'];
    if (!look) return null;
    return (
        <span data-card-status={card.state} role="img" aria-label={look.word} title={look.word} className={`absolute right-3 top-3 grid size-5 place-items-center rounded-full ${look.tone}`}>
            <Icon name={look.icon} size="xs" />
        </span>
    );
}

/** The step, the elapsed time, and a bar, ON the card; the rest of the page goes on working. */
function CardProgress({ card, progress }: { card: ToolCard; progress: { step: string; elapsed: string | null } }) {
    return (
        <div data-card-progress={card.key} {...(card.tool ? { 'data-tool-updating': card.tool.tool } : {})} className="mt-auto flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--fg-2)]">
                <span className="flex min-w-0 items-center gap-1.5"><Icon name="loader-circle" size="xs" className="shrink-0 animate-spin" /><span className="truncate">{progress.step}</span></span>
                {progress.elapsed !== null ? <span data-card-elapsed="" className="shrink-0 font-mono">{progress.elapsed}</span> : null}
            </div>
            <Progress indeterminate size="sm" color="blue" aria-label={`${card.title}: ${progress.step}`} />
        </div>
    );
}

/**
 * ONE TOOL'S CARD: its logo, name and version, its versions as chips (the default starred), its status, and ONE primary
 * action (`data-card-primary`) — or, while something runs for it, the progress. Clicking the card opens its panel; that
 * is never disabled, so the page stays usable while anything runs. Hook-free: what it renders is what is tested.
 */
export function ToolCardView({ card, selected, busy, updating, updated, refusal, check, install, progress, onSelect, onAction }: {
    card: ToolCard; selected: boolean; busy: boolean; updating: ToolchainData['updating'] | null; updated: ToolchainData['updated'] | null;
    refusal: ToolchainRefusal | null; check: ToolCheckState | undefined; install: InstallPreview | undefined;
    progress: { step: string; elapsed: string | null } | null; onSelect: () => void; onAction: SurfaceProps['onAction'];
}) {
    const t = card.tool;
    const missing = card.state === 'missing';
    const versionsButton = card.lang !== null || card.key === 'playwright'
        ? <Button type="button" size="sm" variant="ghost" data-open-panel={card.key} onClick={onSelect}>{card.key === 'playwright' ? 'Browsers' : 'Versions'}</Button>
        : null;
    const note = installNote(install);
    let actions: React.ReactNode = null;
    if (t && t.tone === 'broken') {
        actions = <span data-card-primary="repair" className="contents"><CliRepairAction t={t} busy={busy} updating={updating} onAction={onAction} /></span>;
    } else if (t && t.signedOut) {
        actions = (
            <>
                <Button type="button" size="sm" color="blue" data-card-primary="login" data-action="toolchain-login" disabled={busy} onClick={() => onAction({ kind: 'toolchain.login', tool: t.tool })}>Log in</Button>
                <Badge variant="soft" size="sm" color="amber" data-tool-signed-out={t.tool}>Not signed in</Badge>
            </>
        );
    } else if (t && t.installed !== null) {
        const offered = t.patch !== undefined || t.upgrade !== undefined || ((t.tone === 'update-available' || t.tone === 'security-update') && t.latest) || t.tone === 'unknown';
        actions = (
            <>
                <span data-card-primary="update" className="contents"><ToolUpdateActions t={t} busy={busy} updating={updating} updated={updated} refusal={refusal} onAction={onAction} /></span>
                {offered ? null : versionsButton}
            </>
        );
    } else if (t && t.installed === null) {
        actions = install && 'label' in install ? (
            <>
                <Button type="button" size="sm" color={card.key === 'docker' ? 'red' : 'blue'} data-card-primary="install" data-action="toolchain-install" disabled={busy} title={install.label} onClick={() => onAction({ kind: 'toolchain.install', tool: t.tool, consent: true })}>Install</Button>
                {note ? <span data-install-note={t.tool} title={install.label} className="font-mono text-[11px] text-[var(--fg-3)]">{note}</span> : null}
            </>
        ) : install ? (
            <span data-install-refused={t.tool} className="text-xs text-[var(--fg-3)]">{install.refused}</span>
        ) : null;
    } else if (card.primary?.kind === 'patch') {
        const lang = card.lang!;
        actions = (
            <>
                <Button type="button" size="sm" color="blue" data-card-primary="patch" data-version={card.primary.version} disabled={busy} title={`Install ${card.title} ${card.primary.version}, beside ${card.primary.from}`} onClick={() => onAction({ kind: INSTALL_KIND[lang], version: (card.primary as { version: string }).version, consent: true } as FeatureAction)}>
                    Install {card.primary.version}
                </Button>
                {versionsButton}
            </>
        );
    } else if (card.primary?.kind === 'install') {
        const lang = card.lang!;
        const version = card.primary.version;
        actions = (
            <>
                <Button type="button" size="sm" color="blue" data-card-primary="install" data-version={version} disabled={busy} onClick={() => onAction({ kind: INSTALL_KIND[lang], version, consent: true } as FeatureAction)}>{card.primary.label}</Button>
                <span className="font-mono text-[11px] text-[var(--fg-3)]">no password</span>
            </>
        );
    } else if (card.refused) {
        actions = <span data-card-refused={card.key} className="text-xs text-[var(--fg-3)]">{card.refused}</span>;
    } else {
        actions = versionsButton;
    }
    return (
        <li
            data-tool-card={card.key}
            {...(t ? { 'data-tool': t.tool, 'data-tone': t.tone } : {})}
            data-card-state={card.state}
            data-selected={selected ? 'true' : 'false'}
            className={`relative flex min-h-28 flex-col gap-2 rounded-xl border p-3 ${missing ? 'border-dashed border-[var(--border-1)] bg-transparent' : 'border-[var(--border-1)] bg-[var(--bg-1)]'} ${selected ? 'border-[var(--primary)] ring-1 ring-[var(--primary)]' : ''}`}
        >
            <Button type="button" variant="ghost" data-select-tool={card.key} aria-pressed={selected} className="h-auto justify-start gap-2.5 p-0 pr-6 text-left hover:bg-transparent" onClick={onSelect}>
                <ToolLogo tool={card.key} />
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold text-[var(--fg-1)]">{card.title}</span>
                    <span className={`truncate font-mono text-xs ${card.version === null ? 'text-[var(--fg-3)]' : 'text-[var(--fg-2)]'}`}>{card.version ?? 'not here'}</span>
                </span>
            </Button>
            <CardStatus card={card} />
            {card.chips.length > 0 ? (
                <span data-version-chips={card.key} className="flex flex-wrap gap-1">
                    {card.chips.map((c) => (
                        <span key={c.version} data-version-chip={`${card.key}:${c.version}`} data-default={c.isDefault ? 'true' : 'false'} className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${c.isDefault ? 'border-[color-mix(in_srgb,var(--primary)_50%,transparent)] bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-[var(--primary)]' : 'border-[var(--border-1)] bg-[var(--bg-2)] text-[var(--fg-2)]'}`}>
                            {c.system ? `system ${c.version}` : c.version}{c.isDefault && !c.system ? ' ★' : ''}
                        </span>
                    ))}
                </span>
            ) : null}
            {check ? <CheckStateMark tool={t?.tool ?? card.key} check={check} /> : null}
            {/* A SECURITY UPDATE is not a badge colour away from "update available" (PHP2Shell, 2026-10-22): the danger colour, and the advisory in words. */}
            {t?.tone === 'security-update' ? <span data-tool-security={t.tool} className="self-start rounded-md bg-[var(--danger)] px-1.5 py-0.5 text-xs font-medium text-white">{toneLabel(t.tone)}</span> : null}
            {t?.advisory ? <span data-tool-advisory={t.tool} className="text-xs text-[var(--danger)]">{t.advisory}</span> : null}
            {/* Tynn #698: an agent CLI the health check found cannot run says why; an Update cannot fix it (the repair is its own action). */}
            {t?.problem ? <span data-tool-problem={t.tool} className="text-xs text-[var(--danger)]">{t.problem}</span> : null}
            {progress ? (
                <CardProgress card={card} progress={progress} />
            ) : (
                <div data-card-actions="" className="mt-auto flex flex-wrap items-center gap-1.5 [&_.ml-auto]:ml-0">{actions}</div>
            )}
            {refusal && t && (t.installed === null || t.tone === 'broken') ? <span data-tool-refusal={t.tool} className="text-xs text-[var(--danger)]">{refusal.reason}</span> : null}
        </li>
    );
}

/** How each language's panel words itself — the words each of its sections used before #962. */
const LANG_COPY: Readonly<Record<LangKey, { readonly heading: string; readonly name: string; readonly means: string; readonly binary: string; readonly source: string; readonly refusedDot: boolean }>> = {
    php: { heading: 'PHP versions', name: 'PHP', means: '`php` is', binary: 'php', source: 'windows.php.net (checked against its published sha256)', refusedDot: false },
    node: { heading: 'Node versions', name: 'Node', means: '`node` is', binary: 'node', source: 'nodejs.org (checked against its published sha256)', refusedDot: false },
    go: { heading: 'Go versions', name: 'Go', means: '`go` is', binary: 'go', source: 'go.dev (checked against its published sha256)', refusedDot: false },
    python: { heading: 'Python versions', name: 'Python', means: '`python` and `pip` are', binary: 'python', source: 'python.org (checked against its published sha256)', refusedDot: true },
    java: { heading: 'Java (Temurin JDKs)', name: 'Java', means: '`java` and `javac` are', binary: 'java', source: 'Eclipse Temurin from Adoptium (checked against its published sha256)', refusedDot: true },
    ruby: { heading: 'Ruby versions', name: 'Ruby', means: '`ruby`, `gem` and `bundle` are', binary: 'ruby', source: "ruby-lang.org's source on Linux, RubyInstaller on Windows (checked against the published sha256)", refusedDot: true },
    rust: { heading: 'Rust versions', name: 'Rust', means: '`rustc` and `cargo` are', binary: 'rustc', source: 'rustup (rust-lang.org; each part verified)', refusedDot: true },
    dotnet: { heading: '.NET SDKs', name: '.NET SDK', means: '`dotnet` is', binary: 'dotnet', source: 'Microsoft (checked against its published sha512)', refusedDot: true },
};

/**
 * THE SIDE PANEL for the chosen card: its logo and what its command points at; a language's versions (the default as a
 * radio, the system copy, the sites pinned to each, a patch per version, Remove, and Install another version); Playwright's
 * browsers; or, for a tool Genie keeps one copy of, what it is and where it updates from.
 */
function ToolPanel({ card, tc, busy, check, onAction, onClose }: { card: ToolCard; tc: ToolchainData; busy: boolean; check: ToolCheckState | undefined; onAction: SurfaceProps['onAction']; onClose: () => void }) {
    const view = card.lang ? langView(tc, card.lang) : undefined;
    const current = card.lang ? tc.defaults?.[card.lang] ?? null : null;
    const binary = card.lang ? LANG_COPY[card.lang].binary : card.tool?.tool ?? card.key;
    const dir = view?.managed.find((m) => m.version === current) as { dir?: string } | undefined;
    return (
        <div data-toolchain-panel={card.key} className="border-b border-[var(--border-1)]">
            <div className="flex items-center gap-3 border-b border-[var(--border-1)] px-5 py-4">
                <ToolLogo tool={card.key} size="lg" />
                <div className="min-w-0">
                    <div className="text-base font-semibold">{card.title}</div>
                    <div className="truncate font-mono text-[11px] text-[var(--fg-3)]">{binary} → {card.version ?? 'not here'}{dir?.dir ? ` · ${dir.dir}` : ''}</div>
                </div>
                <Button type="button" size="xs" variant="ghost" className="ml-auto" aria-label="Close" onClick={onClose}><Icon name="x" size="xs" /></Button>
            </div>
            {card.lang && view ? (
                <LanguagePanel lang={card.lang} view={view} current={current} busy={busy} check={check} onAction={onAction} refusals={(tc.refusals ?? []).filter((r) => r.tool === card.lang && r.version !== undefined)} />
            ) : card.key === 'playwright' && tc.playwright ? (
                <PlaywrightBrowsers playwright={tc.playwright} busy={busy} onAction={onAction} refusals={(tc.refusals ?? []).filter((r) => r.tool === 'playwright')} />
            ) : (
                <section data-tool-panel={card.key} className="flex flex-col gap-1 px-5 py-3.5 text-sm">
                    <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-3)]">On this machine</h4>
                    <p className="text-[var(--fg-2)]">{card.tool?.installed ? `${card.title} ${card.tool.installed}` : `${card.title} is not on this machine.`}</p>
                    {card.tool?.latest && card.tool.latest !== card.tool.installed ? <p className="text-xs text-[var(--fg-3)]">Newest: {card.tool.latest}</p> : null}
                    {card.tool?.source ? <p className="text-xs text-[var(--fg-3)]">Updates from {card.tool.source}.</p> : null}
                    {card.tool?.signedOut ? <p className="text-xs text-[var(--warning)]">Signed out: its agents start once you log in.</p> : null}
                </section>
            )}
        </div>
    );
}

/**
 * ONE LANGUAGE'S VERSIONS, in the panel: "what `php` means everywhere" as a radio per version and one for the system's
 * copy; each version's sites (a pinned version's Remove is refused, and says why before it is pressed), its advisory and
 * its patch (installed BESIDE it, never switching anything); and Install another version — or, where Genie installs none
 * here, why. Every handle is the one its section had before #962 (`data-<lang>-version`, `-install`, `-refusal`…).
 */
function LanguagePanel({ lang, view, current, busy, check, onAction, refusals }: { lang: LangKey; view: NonNullable<ReturnType<typeof langView>>; current: string | null; busy: boolean; check: ToolCheckState | undefined; onAction: SurfaceProps['onAction']; refusals: readonly ToolchainRefusal[] }) {
    const copy = LANG_COPY[lang];
    const addable = view.available.filter((a) => !a.installed);
    const attr = (suffix: string, value: string | number) => ({ [`data-${lang}-${suffix}`]: String(value) });
    return (
        <section {...attr('versions', view.managed.length)} className="flex flex-col gap-1.5 px-5 py-3.5">
            <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-3)]">
                <span>Default · what <span className="font-mono normal-case">{copy.binary}</span> means everywhere</span>
                {check ? <CheckStateMark tool={lang} check={check} /> : null}
            </h4>
            {current !== null ? <p className="text-xs text-[var(--fg-3)]">{copy.means} {copy.name} {current}, Genie's default.</p> : null}
            {refusals.map((r) => (
                <p key={r.version} {...attr('refusal', r.version ?? '')} className="text-xs text-[var(--danger)]">{r.reason}</p>
            ))}
            <ul role="radiogroup" aria-label={`${copy.name}: the default`} className="flex flex-col gap-1.5">
                {view.managed.map((m) => {
                    const usedBy = (m as { usedBy?: readonly string[] }).usedBy;
                    const advisory = (m as { advisory?: string }).advisory;
                    const patch = patchFor(lang, m.version, view);
                    const isDefault = m.version === current;
                    const pinned = usedBy !== undefined && usedBy.length > 0;
                    return (
                        <li key={m.version} {...attr('version', m.version)} {...(usedBy !== undefined ? attr('used', usedBy.length) : {})} data-default={isDefault ? 'true' : 'false'} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-2)] px-2.5 py-2 text-sm">
                            <DefaultMark lang={lang} version={m.version} current={current} busy={busy} onAction={onAction} />
                            <b className="font-semibold">{m.version}</b>
                            {advisory ? <Badge variant="soft" size="sm" color="red">security fix</Badge> : null}
                            <span className="flex-1" />
                            {pinned ? <span title={`pinned by ${usedBy!.join(', ')}`} className="rounded bg-[var(--bg-3)] px-1.5 text-[11px] text-[var(--fg-2)]">{usedBy!.length === 1 ? usedBy![0] : `${usedBy!.length} sites`}</span> : null}
                            {patch !== null ? (
                                <Button size="xs" type="button" color={advisory ? 'red' : 'blue'} data-patch-update={`${lang}:${m.version}`} data-version={patch} disabled={busy} title={`Install ${copy.name} ${patch}, beside ${m.version}`} onClick={() => onAction({ kind: INSTALL_KIND[lang], version: patch, consent: true } as FeatureAction)}>
                                    → {patch}
                                </Button>
                            ) : null}
                            <Button size="xs" type="button" variant="ghost" disabled={busy || pinned || isDefault} title={pinned ? `Pinned by ${usedBy!.join(', ')} — change their PHP version first` : isDefault ? `${copy.name} ${m.version} is the default — make another version the default first` : undefined} onClick={() => onAction({ kind: REMOVE_KIND[lang], version: m.version } as FeatureAction)}>Remove</Button>
                            {advisory ? <span {...attr('advisory', m.version)} className="basis-full text-xs text-[var(--danger)]">{advisory}</span> : null}
                        </li>
                    );
                })}
                <li {...attr('system-row', '')} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-2)] px-2.5 py-2 text-sm">
                    {current === null ? (
                        <span role="radio" aria-checked="true" data-system-default={lang} title="The default" className="grid size-4 shrink-0 place-items-center rounded-full border-2 border-[var(--primary)]"><span className="size-1.5 rounded-full bg-[var(--primary)]" /></span>
                    ) : (
                        <Button size="xs" type="button" variant="ghost" role="radio" aria-checked="false" data-use-system={lang} disabled={busy} title="Use the one on your PATH instead" className="size-4 shrink-0 rounded-full border-2 border-[var(--border-1)] p-0" onClick={() => onAction({ kind: 'toolchain.setDefault', lang, version: null })}>
                            <span className="sr-only">Use the one on your PATH instead</span>
                        </Button>
                    )}
                    <span>System</span>
                    <span className="font-mono text-[11px] text-[var(--fg-3)]">{view.system ? `${copy.binary} ${view.system.version}` : 'none on your PATH'}</span>
                </li>
            </ul>
            <p {...attr('system', '')} className="text-xs text-[var(--fg-3)]">
                {lang === 'php'
                    ? view.system ? `Unpinned php sites run PHP ${view.system.version} from your PATH.` : 'No php-cgi on your PATH: an unpinned php site cannot start until PHP is installed above.'
                    : view.system ? `The ${copy.binary} on your PATH is ${view.system.version}.` : `No ${copy.binary} on your PATH.`}
            </p>
            {/* THE FLOOR (PHP2Shell, core/php-advisories.ts): a version under it says so in red, beside the number — never a quiet "update available". */}
            {lang === 'php' && view.system?.advisory ? <p data-php-system-advisory="" className="text-xs text-[var(--danger)]">{view.system.advisory}</p> : null}
            {view.installRefused ? (
                <p {...attr('install-refused', '')} className="text-xs text-[var(--fg-3)]">{view.installRefused}{copy.refusedDot ? '.' : ''}</p>
            ) : addable.length > 0 ? (
                <InstallAnother lang={lang} addable={addable} busy={busy} onAction={onAction} />
            ) : null}
        </section>
    );
}

/** INSTALL ANOTHER VERSION: the versions this release offers in a select, and one Install — the click is the consent. */
function InstallAnother({ lang, addable, busy, onAction }: { lang: LangKey; addable: ReadonlyArray<{ readonly version: string; readonly line?: number }>; busy: boolean; onAction: SurfaceProps['onAction'] }) {
    const copy = LANG_COPY[lang];
    const newest = lang === 'java' ? [...addable].sort((a, b) => (b.line ?? 0) - (a.line ?? 0))[0]!.version : addable[0]!.version;
    const [picked, setPicked] = useState(newest);
    const version = addable.some((a) => a.version === picked) ? picked : newest;
    return (
        <div data-install-another={lang} className="mt-1 flex flex-wrap items-center gap-2">
            <Select
                list={addable.map((a) => ({ value: a.version, label: lang === 'java' && a.line !== undefined ? `${a.line} LTS · ${a.version}` : a.version }))}
                value={version}
                onValueChange={setPicked}
                aria-label={`${copy.name} version to install`}
                className="w-40"
            />
            <Button size="sm" type="button" color="blue" {...{ [`data-${lang}-install`]: version }} disabled={busy} title={`From ${copy.source}`} onClick={() => onAction({ kind: INSTALL_KIND[lang], version, consent: true } as FeatureAction)}>Install</Button>
            <span className="font-mono text-[11px] text-[var(--fg-3)]">no password</span>
        </div>
    );
}

/** THE ACTIVITY FEED: what runs now, what finished, the last outcome, and what Check and repair found. */
function ActivityFeed({ tc }: { tc: ToolchainData }) {
    const items = toolchainActivity(tc);
    const findings = tc.findings ?? [];
    return (
        <section data-toolchain-activity={items.length} className="flex-1 px-5 py-3.5">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-3)]">Activity</h4>
            {items.length === 0 ? <p className="text-xs text-[var(--fg-3)]">Nothing has run yet.</p> : null}
            <ul className="flex flex-col">
                {items.filter((a) => a.kind !== 'finding').map((a, i) => (
                    <li key={i} data-activity={a.kind} {...(a.kind === 'running' && a.source === 'busy' ? { 'data-toolchain-busy': '' } : {})} {...(a.kind === 'note' ? { 'data-toolchain-result': '' } : {})} className="flex gap-2.5 py-1.5 text-xs text-[var(--fg-2)]">
                        {a.kind === 'running' ? <Icon name="loader-circle" size="xs" className="mt-0.5 shrink-0 animate-spin" /> : a.kind === 'done' ? <Icon name="check" size="xs" className="mt-0.5 shrink-0 text-[var(--success)]" /> : <Icon name="info" size="xs" className="mt-0.5 shrink-0" />}
                        <span>{a.text}</span>
                    </li>
                ))}
            </ul>
            {findings.length > 0 ? (
                <ol data-toolchain-findings={findings.length} className="flex flex-col">
                    {findings.map((f, i) => (
                        <li key={`${f.kind}-${i}`} data-finding={f.kind} data-result={f.result.kind} className="flex gap-2.5 py-1.5 text-xs text-[var(--fg-2)]">
                            {f.result.kind === 'repaired' ? <Icon name="check" size="xs" className="mt-0.5 shrink-0 text-[var(--success)]" /> : <Icon name="x" size="xs" className="mt-0.5 shrink-0 text-[var(--danger)]" />}
                            <span>
                                {f.kind === 'path-shadow' ? `${f.tool} ${f.first.version} at ${f.first.path} was running instead of ${f.newer.version} at ${f.newer.path}. ` : f.kind === 'php-ca' || f.kind === 'genie-node' ? `${f.problem}. ` : `Missing: ${f.missing.join(', ')}. `}
                                {f.result.kind === 'repaired' ? f.result.detail : f.result.reason}
                            </span>
                        </li>
                    ))}
                </ol>
            ) : null}
        </section>
    );
}

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Genie's one Playwright browser install: version, size, Update (Tynn #604). Every workspace and worktree uses it. */
/** A version typed into the Playwright section, as the install it asks for (Tynn #846): x.y.z's Chromium, or `null`. */
export function playwrightInstallChosen(text: string): FeatureAction | null {
    const version = text.trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? { kind: 'toolchain.installPlaywright', version, browsers: ['chromium'], consent: true } : null;
}

function PlaywrightBrowsers({ playwright, busy, onAction, refusals = [] }: { playwright: NonNullable<NonNullable<FeatureData['toolchain']>['playwright']>; busy: boolean; onAction: SurfaceProps['onAction']; refusals?: readonly ToolchainRefusal[] }) {
    const newest = playwright.sets[0]?.version ?? null;
    const outdated = playwright.latest !== null && newest !== playwright.latest;
    // Any version, typed (Tynn #846): a project pinned to an older Playwright gets its own set beside the others.
    const [chosen, setChosen] = useState('');
    const chosenAction = playwrightInstallChosen(chosen);
    return (
        <section data-playwright-browsers={playwright.sets.length} className="border-b border-[var(--border-1)]">
            <div className="flex items-center gap-3 px-5 pt-3">
                <h3 className="text-sm font-medium">Playwright browsers</h3>
                <span data-playwright-size="" className="text-xs text-[var(--fg-3)]">{formatBytes(playwright.totalBytes)}</span>
                <span data-playwright-stable={playwright.stable} className="text-xs text-[var(--fg-3)]">Stable: {playwright.stable}</span>
            </div>
            <p className="px-5 py-1 text-xs text-[var(--fg-3)]">One install for every workspace and worktree, kept by Genie: it installs the stable version, and each version a project pins, by itself. <span className="font-mono">{playwright.browsersPath}</span></p>
            {refusals.map((r) => (
                <p key={r.version ?? 'latest'} data-playwright-refusal={r.version ?? 'latest'} className="px-5 py-1 text-xs text-[var(--danger)]">{r.reason}</p>
            ))}
            <ul className="divide-y divide-[var(--border-1)]">
                {playwright.sets.map((s) => (
                    <li key={s.version} data-playwright-version={s.version} className="flex flex-wrap items-center gap-3 px-5 py-2 text-sm">
                        <span className="font-medium">Playwright {s.version}</span>
                        {s.version === playwright.stable ? <span data-playwright-stable-set={s.version} className="rounded bg-[var(--bg-3)] px-1.5 text-[11px] text-[var(--fg-2)]">stable</span> : null}
                        <span className="text-xs text-[var(--fg-3)]">{s.browsers.join(', ')}</span>
                        {!s.ready ? (
                            <Button size="xs" type="button" data-playwright-reinstall={s.version} disabled={busy} className="ml-auto shrink-0 text-[13px]" onClick={() => onAction({ kind: 'toolchain.installPlaywright', version: s.version, browsers: s.browsers, consent: true })}>Its browsers are gone: install again</Button>
                        ) : s.version === newest && outdated && playwright.latest !== null ? (
                            <Button size="xs" type="button" data-playwright-update={playwright.latest} disabled={busy} className="ml-auto shrink-0 text-[13px]" onClick={() => onAction({ kind: 'toolchain.installPlaywright', version: playwright.latest, browsers: s.browsers, consent: true })}>Add {playwright.latest}</Button>
                        ) : null}
                    </li>
                ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm">
                {playwright.sets.length === 0 ? (
                    <Button size="xs" type="button" data-playwright-install="stable" disabled={busy} className="rounded-lg border border-[var(--border-1)] px-2 py-0.5 text-[13px]" onClick={() => onAction({ kind: 'toolchain.installPlaywright', version: null, browsers: ['chromium'], consent: true })}>Install Chromium (Playwright {playwright.stable})</Button>
                ) : null}
                <input data-playwright-version-input="" value={chosen} onChange={(e) => setChosen(e.target.value)} placeholder="1.62.1" aria-label="Playwright version to install" className="w-24 rounded-lg border border-[var(--border-1)] bg-transparent px-2 py-0.5 font-mono text-[13px]" />
                <Button size="xs" type="button" data-playwright-install-chosen="" disabled={busy || chosenAction === null} className="rounded-lg border border-[var(--border-1)] px-2 py-0.5 text-[13px]" onClick={() => { if (chosenAction) { onAction(chosenAction); setChosen(''); } }}>Install this version</Button>
                {newest !== null ? playwright.optional.filter((b) => !(playwright.sets[0]?.browsers ?? []).includes(b)).map((b) => (
                    <Button size="xs" key={b} type="button" data-playwright-add={b} disabled={busy} className="rounded-lg border border-[var(--border-1)] px-2 py-0.5 text-[13px]" onClick={() => onAction({ kind: 'toolchain.installPlaywright', version: newest, browsers: [b], consent: true })}>Add {b}</Button>
                )) : null}
            </div>
        </section>
    );
}

/**
 * YOUR TERMINALS (plan TC3b; the owner's decision 3): Genie's defaults on the machine's own PATH, once, with consent.
 * Before anything changes it says EXACTLY what would — the entries, and where — and after, where it is, with Undo.
 */
function MachinePathCard({ mp, busy, onAction, refusal }: { mp: NonNullable<NonNullable<FeatureData['toolchain']>['machinePath']>; busy: boolean; onAction: SurfaceProps['onAction']; refusal: string | null }) {
    return (
        <section data-machine-path={mp.applied ? 'on' : 'off'} className="border-b border-[var(--border-1)] px-5 py-3 text-sm">
            <h3 className="text-sm font-medium">Your terminals</h3>
            {refusal ? <p className="py-1 text-xs text-[var(--danger)]">{refusal}</p> : null}
            {mp.applied ? (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-[var(--fg-3)]">
                    <span>Terminals outside Genie use Genie's defaults too (set in {mp.where.join(', ')}).</span>
                    <Button size="xs" type="button" data-machine-path-undo="" disabled={busy} className="text-[12px]" onClick={() => onAction({ kind: 'toolchain.machinePath', apply: false })}>Undo</Button>
                </div>
            ) : (
                <div className="flex flex-col gap-1 pt-1 text-xs text-[var(--fg-3)]">
                    <span>Genie's defaults apply to Genie's own terminals, processes and agents. To use them in every terminal, Genie adds these to the front of your PATH, once:</span>
                    <ul className="font-mono">{mp.entries.map((e) => <li key={e}>{e}</li>)}</ul>
                    <span>in {mp.targets.join(', ')}. Nothing else changes, and Undo puts it back exactly.</span>
                    <Button size="xs" type="button" data-machine-path-apply="" disabled={busy} className="self-start rounded-lg border border-[var(--border-1)] px-2 py-0.5 text-[13px] text-[var(--fg-1)]" onClick={() => onAction({ kind: 'toolchain.machinePath', apply: true, consent: true })}>
                        Use Genie's defaults in every terminal
                    </Button>
                </div>
            )}
        </section>
    );
}

/** A managed version's default state: the Default mark on the chosen one, "Make default" on the others (plan TC3a). */
function DefaultMark({ lang, version, current, busy, onAction }: { lang: 'node' | 'go' | 'php' | 'python' | 'dotnet' | 'rust' | 'ruby' | 'java'; version: string; current: string | null; busy: boolean; onAction: SurfaceProps['onAction'] }) {
    // The default as a RADIO (Tynn #962): what the command means everywhere is one choice among the versions and the system's.
    if (version === current) {
        return (
            <span role="radio" aria-checked="true" data-is-default={`${lang}:${version}`} title="The default" className="grid size-4 shrink-0 place-items-center rounded-full border-2 border-[var(--primary)]">
                <span className="size-1.5 rounded-full bg-[var(--primary)]" />
            </span>
        );
    }
    return (
        <Button size="xs" type="button" variant="ghost" role="radio" aria-checked="false" data-make-default={`${lang}:${version}`} disabled={busy} title={`Make ${version} the default`} className="size-4 shrink-0 rounded-full border-2 border-[var(--border-1)] p-0" onClick={() => onAction({ kind: 'toolchain.setDefault', lang, version })}>
            <span className="sr-only">Make default</span>
        </Button>
    );
}

/** The composer's attachment state, held by the Shell: picked host paths, the picker, removal, and the clear after a send. */
export interface InboxCompose {
    readonly attachments: readonly string[];
    readonly onPick: () => void;
    readonly onRemove: (path: string) => void;
    readonly onClear?: (() => void) | undefined;
}


/** 2048 → "2.0 kB"; 14 → "14 B"; honest units, one decimal above bytes. */
export function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${bytes} B`;
}



/**
 * PRIMARY WORKSPACE (Genie 1's Settings → General first row; the owner, 2026-10-21): where a new workspace lands, and
 * where a folder picker opened from the workstation starts. A folder, chosen with Browse over the HOST's disk — never typed.
 */
function PrimaryWorkspaceRow({ value, onAction }: { value: string | null; onAction: SurfaceProps['onAction'] }) {
    const pickHostPath = useHostPathPicker();
    const browse = () => {
        void pickHostPath?.({ mode: 'directory', title: 'Choose primary workspace folder', ...(value ? { initialPath: value } : {}) }).then((p) => {
            if (typeof p === 'string') onAction({ kind: 'settings.set', key: 'primary_workspace', value: p });
        });
    };
    return (
        <div data-primary-workspace="" className="flex items-center gap-4 py-2.5">
            <div className="flex-1">
                <div className="text-sm font-medium">Primary workspace</div>
                <div className="text-xs text-[var(--fg-3)]">Default destination for NEW projects created from Genie. Existing projects can live anywhere — this is a default, not a constraint.</div>
            </div>
            <input readOnly value={value ?? ''} placeholder="No primary workspace chosen" className="w-64 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1 font-mono text-xs" />
            {pickHostPath ? <Button size="xs" type="button" data-action="browse-primary-workspace" onClick={browse} className="rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]">Browse</Button> : null}
        </div>
    );
}
function SettingControl({ def, value, onAction, customPath }: { def: SettingDef; value: boolean | string | null; onAction: SurfaceProps['onAction']; customPath?: boolean | string | undefined }) {
    // Your own sound file (Tynn #766 B2), picked over the HOST's disk in the window (Tynn #835): sound files only.
    const pickHostPath = useHostPathPicker();
    const pickSound = () => {
        void pickHostPath?.({ mode: 'file', title: 'Choose a sound', extensions: SOUND_FILE_EXTENSIONS }).then((p) => {
            if (typeof p === 'string') onAction({ kind: 'settings.setSoundFile', key: def.key, path: p });
        });
    };
    if (value === null) return <Skeleton shape="text" width={80} />;
    if (def.type === 'boolean') {
        return <Switch checked={value === true} onCheckedChange={(checked) => onAction({ kind: 'settings.set', key: def.key, value: checked })} aria-label={def.label} />;
    }
    if (def.type === 'enum') {
        if (!isAlertSoundKey(def.key)) {
            return <Select list={def.options.map((o) => ({ value: o, label: def.optionLabels?.[o] ?? o }))} value={String(value)} onValueChange={(v) => onAction({ kind: 'settings.set', key: def.key, value: v })} aria-label={def.label} />;
        }
        // An alert's sound (Tynn #711): a Button naming it opens a popover of the sounds in their groups, each with its own
        // play button that previews it WITHOUT choosing it. Custom file… opens the host's picker (Tynn #766 B2); the row
        // becomes Custom file only once a file is chosen. A preview plays through the alert's own player, one at a time.
        const kind = def.key.slice('sound_'.length) as AlertKind;
        const hasCustom = typeof customPath === 'string' && customPath.trim() !== '';
        const file = value === 'custom' && hasCustom ? customPath.split(/[\\/]/).pop() : null;
        return (
            <span className="flex items-center gap-2">
                <SoundPicker
                    value={String(value)}
                    label={def.label}
                    onSelect={(v) => { if (v === 'custom') pickSound(); else onAction({ kind: 'settings.set', key: def.key, value: v }); }}
                    onPreview={(v) => playPreviewSound(previewSound(kind, v, customPath), previewVolume(kind, clientSoundValues()))}
                    canPreview={(v) => v !== 'off' && (v !== 'custom' || hasCustom)}
                />
                {file ? (
                    <span data-sound-custom={def.key} title={String(customPath)} className="max-w-[160px] truncate text-xs text-[var(--fg-3)]">{file}</span>
                ) : null}
                {value === 'custom' ? (
                    <Button type="button" size="sm" variant="ghost" data-action="sound-pick" onClick={pickSound}>Change…</Button>
                ) : null}
            </span>
        );
    }
    return <Input defaultValue={String(value)} onBlur={(e) => onAction({ kind: 'settings.set', key: def.key, value: e.target.value })} aria-label={def.label} />;
}

export function SettingsSurface({ data, onAction, onNavigate, section, workspaces = [], remoteConnect, query, update, providers, marketplace, accountsSettings }: SurfaceProps & { section: SectionId | null; remoteConnect?: RemoteConnectProps | undefined; query?: string | undefined; update?: UpdateCheckProps | undefined; providers?: readonly ProviderStatus[] | undefined; marketplace?: MarketplaceApi | undefined; accountsSettings?: Pick<AccountsSettingsProps, 'snapshot' | 'onSwitch' | 'onAct' | 'onDesignSignIn'> | undefined }) {
    const values = data.settings.values;
    const active: SectionId = section ?? 'general';
    // SEARCH across every page (§6.9). Transient view state: a query is not a place, so it is not in the route.
    const [q, setQ] = useState(query ?? '');
    const results = q.trim() ? searchSettings(q.trim()).filter((def) => sectionOf(def.key) !== null) : null;
    const row = (def: SettingDef) => (
        <li key={def.key} data-setting={def.key} className="flex items-center gap-4 py-2.5">
            <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{def.label}</div>
                <div className="text-xs text-[var(--fg-3)]">{def.description}</div>
            </div>
            <div data-setting-control="" className="flex w-64 shrink-0 items-center justify-end gap-2">
                <SettingControl def={def} value={values === null ? null : values[def.key] ?? def.default} onAction={onAction} customPath={values?.[`${def.key}_custom`]} />
            </div>
        </li>
    );
    // The settings a page draws as rows: its keys, in the registry's order. Internal (`hidden`) keys and the alert sounds
    // have their own blocks.
    const rows = (s: SectionId) => {
        const defs = SETTINGS.filter((def) => sectionOf(def.key) === s && !def.hidden && !isAlertSoundKey(def.key) && !NEW_PROJECT_DEFAULTS.includes(def.key));
        return defs.length === 0 ? null : <ul className="divide-y divide-[var(--border-1)]" data-skeleton={values === null ? '' : undefined}>{defs.map(row)}</ul>;
    };
    // General's "Defaults for new projects": Primary workspace's own row, then the env file name (Genie 1's pair).
    const newProjectRows = SETTINGS.filter((def) => NEW_PROJECT_DEFAULTS.includes(def.key));
    const label = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === active)?.label ?? 'General';
    return (
        <div data-surface="settings" className="flex h-full min-h-0 flex-col">
            <Header title="Settings" />
            <div className="flex min-h-0 flex-1">
                {/* GENIE 1'S SIDEBAR: grouped sections, one page each (core/settings-nav.ts). */}
                {/* A MENU, NOT BUTTONS (the owner, 2026-11-01: "those should not be buttons, it's a menu"): react-fancy's
                    Sidebar, embedded in the page; its items sit left, the page on screen is aria-current="page", and they ring on
                    keyboard focus only. The Sidebar draws the <nav aria-label="Settings"> itself (`navLabel`), and `keyboardNav` makes
                    the items one tab stop that Up / Down / Home / End move through. The search box sits above it, outside the nav. */}
                <div data-settings-sidebar="" className="flex w-56 shrink-0 flex-col gap-3 overflow-auto border-r border-[var(--border-1)] px-2 py-3">
                    <Input data-settings-search type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" leading={<Icon name="search" size="xs" />} />
                    <Sidebar embedded navLabel="Settings" keyboardNav>
                        {NAV_GROUPS.map((g) => (
                            <div key={g.label} data-settings-nav-group={g.label} className="mb-3 last:mb-0">
                                <Sidebar.Group label={g.label} className="flex flex-col gap-0.5 py-0">
                                    {g.items.map((i) => (
                                        <Sidebar.Item key={i.id} data-settings-nav={i.id} data-nav-target={`genie://settings/${i.id}`} active={i.id === active && results === null}
                                            icon={<Icon name={i.icon} size="sm" className="text-[var(--fg-4)]" />}
                                            onClick={() => { setQ(''); onNavigate(`genie://settings/${i.id}`); }}
                                            className="h-[30px] px-2 text-[13px]">
                                            {i.label}
                                        </Sidebar.Item>
                                    ))}
                                </Sidebar.Group>
                            </div>
                        ))}
                    </Sidebar>
                </div>
                <div className="min-w-0 flex-1 overflow-auto">
                    {results !== null ? (
                        results.length === 0 ? (
                            <p className="px-6 py-4 text-sm text-[var(--fg-3)]">No setting matches “{q.trim()}”.</p>
                        ) : (
                            <ul data-settings-results className="divide-y divide-[var(--border-1)] px-6" data-skeleton={values === null ? '' : undefined}>
                                {results.map((def) => {
                                    const at = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === sectionOf(def.key));
                                    return (
                                        <li key={def.key} data-setting={def.key} data-setting-section={at?.id} className="flex items-center gap-4 py-2.5">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 text-sm font-medium">{def.label}{at ? <Badge variant="soft" size="sm">{at.label}</Badge> : null}</div>
                                                <div className="text-xs text-[var(--fg-3)]">{def.description}</div>
                                            </div>
                                            <div data-setting-control="" className="flex w-64 shrink-0 items-center justify-end gap-2">
                                                <SettingControl def={def} value={values === null ? null : values[def.key] ?? def.default} onAction={onAction} customPath={values?.[`${def.key}_custom`]} />
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )
                    ) : (
                        <div data-settings-page={active}>
                            <h1 className="px-6 pt-4 text-base font-semibold">{label}</h1>
                            {active === 'general' ? (
                                <>
                                    {update ? <UpdatesBlock {...update} /> : null}
                                    <SetSection title="Defaults for new projects" desc="Where Genie puts what it makes.">
                                        <PrimaryWorkspaceRow value={values === null ? null : typeof values['primary_workspace'] === 'string' ? (values['primary_workspace'] as string) : ''} onAction={onAction} />
                                        <ul className="divide-y divide-[var(--border-1)] border-t border-[var(--border-1)]" data-skeleton={values === null ? '' : undefined}>{newProjectRows.map(row)}</ul>
                                    </SetSection>
                                    <SetSection title="Startup and focus" desc="What Genie does when it starts, and Do not disturb.">{rows('general')}</SetSection>
                                </>
                            ) : null}
                            {active === 'notifications' ? (
                                <>
                                    <SetSection title="Notifications" desc="The master switch for every sound.">{rows('notifications')}</SetSection>
                                    <SoundVolume values={values} />
                                    <AlertSounds values={values} onAction={onAction} />
                                    <RateLimitAlerts raw={values === null ? undefined : values[LIMIT_ALERTS_SETTING]} onAction={onAction} />
                                </>
                            ) : null}
                            {active === 'keyboard' ? <GenieHotkeys values={values} onAction={onAction} /> : null}
                            {active === 'appearance' ? <SetSection title="Appearance" desc="How Genie looks on this device.">{rows('appearance')}</SetSection> : null}
                            {active === 'tynn' ? <SetSection title="Tynn" desc="Optional: identity, your projects, and IssueWatch. Genie is fully usable signed out." data-settings-tynn=""><TynnBlock integrations={data.integrations} onAction={onAction} /></SetSection> : null}
                            {active === 'github' ? <SetSection title="GitHub" desc="Sign in to the Genie AOS app: who you are on GitHub, where the app is installed, and what it may do there." data-settings-github=""><GithubBlock integrations={data.integrations} onAction={onAction} /></SetSection> : null}
                            {active === 'providers' ? <SetSection title="Providers" desc="The agent CLIs Genie runs, and whether each is signed in." data-settings-providers=""><ProvidersBlock providers={providers} onNavigate={onNavigate} />{accountsSettings ? <AccountsSettings {...accountsSettings} offerWindows={values === null ? undefined : values[SWITCH_OFFER_WINDOWS_SETTING]} onSetOfferWindows={(value) => onAction({ kind: 'settings.set', key: SWITCH_OFFER_WINDOWS_SETTING, value })} /> : null}</SetSection> : null}
                            {active === 'workspace-defaults' ? <SetSection title="Defaults for workspaces" desc="What every workspace uses unless its own Settings override it.">{rows('workspace-defaults')}</SetSection> : null}
                            {active === 'prompts' ? <SavedPrompts raw={values === null ? undefined : values['saved_prompts']} bindings={bindingsFrom(values)} onAction={onAction} /> : null}
                            {active === 'agent-mcp' ? (
                                <>
                                    <SetSection title="Genie’s MCP server" desc="What every agent session is given." data-settings-mcp=""><McpServerBlock integrations={data.integrations} /></SetSection>
                                    <SetSection title="Agent files in workspaces" desc="Which harness configs Genie writes into every workspace when it starts and when one is added. Each workspace’s status, and a Sync now for it, are in each workspace’s own Settings." data-workspace-files-note="">{rows('agent-mcp')}</SetSection>
                                </>
                            ) : null}
                            {active === 'plugins' ? (
                                <>
                                    <SetSection title="Developer mode" desc="Unsigned local plugins, labelled as such.">{rows('plugins')}</SetSection>
                                    <PluginsPage plugins={data.plugins} onAction={onAction} marketplace={marketplace ? <MarketplacePane api={marketplace} /> : undefined} />
                                </>
                            ) : null}
                            {active === 'remote' ? <RemoteAccess remote={data.remote} workspaces={workspaces} onAction={onAction} connect={remoteConnect} /> : null}
                            {active === 'terminals' ? <SetSection title="Terminals" desc="Shells and builds in your workspaces.">{rows('terminals')}</SetSection> : null}
                            {/* TOOLCHAIN LIVES HERE (beta.33 item 20; the owner: "Tool chain is a Settings thing, it should not be its own page in the menu"): the whole of it, in this section. */}
                            {active === 'toolchain' ? <div data-settings-toolchain="" className="min-h-0"><ToolchainSurface data={data} onAction={onAction} onNavigate={onNavigate} /></div> : null}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** A provider as the Providers page shows it: installed (Toolchain), and an agent of it that is signed out (#971), if any. */
export interface ProviderStatus {
    readonly provider: string;
    readonly name: string;
    readonly installed: boolean | null;
    readonly version: string | null;
    readonly signedOut: { readonly agentId: string; readonly agentName: string } | null;
    readonly onLogin?: ((agentId: string) => void) | undefined;
}

export function ProvidersBlock({ providers, onNavigate }: { providers: readonly ProviderStatus[] | undefined; onNavigate: SurfaceProps['onNavigate'] }) {
    if (providers === undefined) return <Skeletons rows={2} />;
    return (
        <ul className="divide-y divide-[var(--border-1)]">
            {providers.map((p) => {
                const out = p.signedOut;
                const login = p.onLogin;
                return (
                    <li key={p.provider} data-provider={p.provider} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                        <ProviderLogo provider={p.provider} size="md" className="text-[var(--fg-1)]" />
                        {p.installed === null ? <span className="text-[var(--fg-3)]">not checked yet</span> : p.installed ? <Badge variant="soft" size="sm">{p.version ?? 'installed'}</Badge> : <span className="text-[var(--warning)]">not installed</span>}
                        {out ? <span data-provider-signed-out={p.provider} className="text-[var(--danger)]">signed out ({out.agentName})</span> : null}
                        <span className="ml-auto flex items-center gap-2">
                            {out && login ? <Button type="button" size="sm" data-action={`provider-login-${p.provider}`} onClick={() => login(out.agentId)}>Log in</Button> : null}
                            {p.installed === false ? <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate('genie://settings/toolchain')}>Install in Toolchain</Button> : null}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * SOUNDS (Tynn #766): a row per kind of action an agent takes, under the four headings it belongs to — Needs you, Its
 * turn, Its work, Messages — each with its choice, Preview, and its own file when it is Custom file.
 */
function AlertSounds({ values, onAction }: { values: Readonly<Record<string, boolean | string>> | null; onAction: SurfaceProps['onAction'] }) {
    return (
        <section data-alert-sounds className="border-b border-[var(--border-1)] px-5 py-3">
            <div className="text-sm font-medium">Sounds</div>
            <div className="mb-1 text-xs text-[var(--fg-3)]">What plays when an agent does each thing. None is silent; the master switch above silences them all.</div>
            {SOUND_GROUPS.map(({ group, label }) => (
                <div key={group} data-sound-group={group} className="mt-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">{label}</div>
                    <ul className="divide-y divide-[var(--border-1)]">
                        {ALERT_KINDS.filter((k) => k.group === group).map((k) => {
                            const def = SETTINGS.find((s) => s.key === `sound_${k.kind}`)!;
                            return (
                                <li key={def.key} data-setting={def.key} className="flex items-center gap-4 py-2">
                                    <div className="flex-1 text-sm">{k.label}</div>
                                    <SettingControl def={def} value={values === null ? null : values[def.key] ?? def.default} onAction={onAction} customPath={values?.[`${def.key}_custom`]} />
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}
        </section>
    );
}


/**
 * RATE-LIMIT ALERTS (Tynn #748; the owner, 2026-11-15): the person adds alerts at the thresholds they choose — percent of a
 * window used, which window (5-hour, weekly, any) and a sound of its own, picked with the sound popover (each with its own
 * play button). Ordered by threshold. None by default: nothing new is heard until one is added. genie-host fires them.
 */
function RateLimitAlerts({ raw, onAction }: { raw: boolean | string | undefined; onAction: SurfaceProps['onAction'] }) {
    const alerts = parseLimitAlerts(raw);
    const save = (next: readonly RateLimitAlert[]): void => onAction({ kind: 'settings.set', key: LIMIT_ALERTS_SETTING, value: serializeLimitAlerts(next) });
    // A new alert starts at 90% on any window with the Default chime; the person edits it in place.
    const add = (): void => save(upsertLimitAlert(alerts, { id: newLimitAlertId(Date.now(), Math.random()), thresholdPct: 90, window: 'any', sound: 'synth' }));
    const canPreview = (v: string): boolean => v !== 'off' && v !== 'custom';
    return (
        <section data-rate-limit-alerts className="border-b border-[var(--border-1)] px-5 py-3">
            <div className="text-sm font-medium">Rate-limit alerts</div>
            <div className="mb-2 text-xs text-[var(--fg-3)]">Hear it when an account passes a share of its rate limit. Each alert has its own sound; it plays once per window and again after the window resets. Do not disturb holds the sound.</div>
            {alerts.length === 0 ? <p className="py-2 text-sm text-[var(--fg-3)]">No rate-limit alerts yet. Add one to be told at the share you choose.</p> : null}
            <ul className="divide-y divide-[var(--border-1)]">
                {alerts.map((alert) => (
                    <li key={alert.id} data-rate-limit-alert={alert.id} className="flex items-center gap-3 py-2">
                        <span className="flex items-center gap-1.5 text-sm">
                            At
                            <Input
                                data-limit-threshold={alert.id}
                                aria-label="Threshold, percent of the window used"
                                type="number"
                                min={1}
                                max={100}
                                defaultValue={String(alert.thresholdPct)}
                                className="w-20"
                                onBlur={(e) => {
                                    const pct = Number(e.target.value);
                                    if (Number.isInteger(pct) && pct >= 1 && pct <= 100) { if (pct !== alert.thresholdPct) save(upsertLimitAlert(alerts, { ...alert, thresholdPct: pct })); } else e.target.value = String(alert.thresholdPct);
                                }}
                            />
                            % used
                        </span>
                        <span data-limit-window={alert.id}>
                            <Select
                                list={LIMIT_WINDOW_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                                value={alert.window}
                                onValueChange={(v) => save(upsertLimitAlert(alerts, { ...alert, window: v as LimitWindowChoice }))}
                                aria-label="Window this alert watches"
                            />
                        </span>
                        <span className="flex-1" />
                        <SoundPicker
                            value={alert.sound}
                            label={`Sound for the ${alert.thresholdPct}% rate-limit alert`}
                            onSelect={(v) => { if (v !== 'custom') save(upsertLimitAlert(alerts, { ...alert, sound: v })); }}
                            onPreview={(v) => playPreviewSound(limitAlertSound(v, {}), previewVolume(null, clientSoundValues()))}
                            canPreview={canPreview}
                        />
                        <Button data-action="limit-alert-remove" type="button" size="sm" variant="ghost" className="justify-start" aria-label={`Remove the ${alert.thresholdPct}% rate-limit alert`} onClick={() => save(removeLimitAlert(alerts, alert.id))}>
                            <Icon name="trash-2" size="sm" />
                        </Button>
                    </li>
                ))}
            </ul>
            <Button data-action="limit-alert-add" type="button" size="sm" className="mt-2 justify-start" onClick={add}>
                <Icon name="plus" size="sm" />
                Add an alert
            </Button>
        </section>
    );
}

/** A key press as core/hotkeys.ts reads it. */
const pressOf = (e: React.KeyboardEvent): { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; typing: boolean } => ({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: false });

/**
 * GENIE'S KEYS (Tynn #759; Genie 1's Settings → "Terminal hotkeys"): the Command Window and the ForceTheQuestion nudge,
 * each RECORDED — click the box, press the keys; Backspace or Reset goes back to Genie's default. A key Genie cannot give
 * it (one you type with, one Genie or a saved prompt already uses) is refused on the row, with the reason.
 */
function GenieHotkeys({ values, onAction }: { values: Readonly<Record<string, boolean | string>> | null; onAction: SurfaceProps['onAction'] }) {
    const [platform, setPlatform] = useState('generic');
    useEffect(() => { setPlatform(detectPlatform(browserPlatformHints()) === 'apple' ? 'darwin' : 'generic'); }, []);
    const bindings = bindingsFrom(values);
    const prompts = parsePromptLibrary(typeof values?.['saved_prompts'] === 'string' ? values['saved_prompts'] : undefined);
    const set = (name: BindingName, value: string): void => onAction({ kind: 'settings.set', key: BINDING_SETTING[name], value });
    // One way to set a key on this page (Tynn issue #697): pressed into the capture control, refused in words there.
    const capture = (name: BindingName) => (accelerator: string): string | null => {
        const problem = bindingProblem(accelerator, name, bindings, prompts, platform);
        if (problem !== null) return problem;
        // Genie's default is stored as empty, so it follows Genie's default.
        set(name, accelerator === DEFAULT_HOTKEYS[name] ? '' : accelerator);
        return null;
    };
    const rows: Array<{ name: BindingName; label: string; desc: string }> = [
        { name: 'commandWindow', label: 'Command Window', desc: 'Search, jump and run — prompts, actions, workspaces, agents.' },
        { name: 'ftqNudge', label: 'ForceTheQuestion nudge', desc: 'Tells the agent in front of you to ask its question through ForceTheQuestion, where you will see it.' },
    ];
    // THE COMPOSER'S SEND KEY (Tynn issue #697): pressed, never typed; the new-line key follows from it.
    const sendKey = sendKeyFrom(values);
    const captureSendKey = (accelerator: string): string | null => {
        const problem = sendKeyProblem(accelerator, bindings, prompts, platform);
        if (problem !== null) return problem;
        // Genie's default is stored as empty, so it follows Genie's default.
        onAction({ kind: 'settings.set', key: SEND_KEY_SETTING, value: accelerator === DEFAULT_SEND_KEY ? '' : accelerator });
        return null;
    };
    return (
        <section data-genie-hotkeys className="border-b border-[var(--border-1)] px-5 py-3">
            <div className="text-sm font-medium">Writing to an agent</div>
            <div data-send-key-setting="" className="flex items-start gap-4 py-2">
                <div className="flex-1">
                    <div className="text-sm">Send message</div>
                    <div className="text-xs text-[var(--fg-3)]">
                        New line: <span data-newline-key="" className="inline-flex items-center gap-1 align-middle">{keycaps(newlineKeyFor(sendKey), platform).map((cap, i) => <Fragment key={cap}>{i > 0 ? '+' : null}<Kbd>{cap}</Kbd></Fragment>)}</span>
                    </div>
                </div>
                <HotkeyCapture value={sendKey} platform={platform} label="Send message" onCapture={captureSendKey}
                    onReset={sendKey === DEFAULT_SEND_KEY ? undefined : () => onAction({ kind: 'settings.set', key: SEND_KEY_SETTING, value: '' })} />
            </div>
            <div className="mt-2 text-sm font-medium">Keyboard shortcuts</div>
            <ul className="mt-1 flex flex-col">
                {rows.map(({ name, label, desc }) => {
                    const raw = values?.[BINDING_SETTING[name]];
                    const stored = typeof raw === 'string' ? raw.trim() : '';
                    const current = bindings[name];
                    return (
                        <li key={name} className="flex flex-col gap-1 py-2">
                            <div className="flex items-start gap-4">
                                <div className="flex-1">
                                    <div className="text-sm">{label}</div>
                                    <div className="text-xs text-[var(--fg-3)]">{current === null ? `“${stored}” is not a key Genie can read — this shortcut is off until you set it again.` : desc}</div>
                                </div>
                                <HotkeyCapture name={name} value={current ?? ''} platform={platform} label={label} onCapture={capture(name)} onReset={stored !== '' ? () => set(name, '') : undefined} />
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/**
 * SAVED PROMPTS (Tynn #758): the Command Window's library, in Settings → Agents — each prompt's name, its text and its
 * hotkey. The hotkey is RECORDED: click the box and press the keys; Backspace clears it. A key Genie cannot give it is
 * refused on the row, with the reason. A new prompt is a draft until it has a name and text — the reader drops a row
 * that cannot be found or sent, so saving an empty one would make it vanish (Genie 1 did).
 */
function SavedPrompts({ raw, bindings, onAction }: { raw: boolean | string | undefined; bindings: HotkeyBindings; onAction: SurfaceProps['onAction'] }) {
    const prompts = parsePromptLibrary(typeof raw === 'string' ? raw : undefined);
    // Resolved after mount, as the title bar's hint is: reading `navigator` while rendering is a hydration mismatch.
    const [platform, setPlatform] = useState('generic');
    useEffect(() => { setPlatform(detectPlatform(browserPlatformHints()) === 'apple' ? 'darwin' : 'generic'); }, []);
    const [refused, setRefused] = useState<{ id: string; reason: string } | null>(null);
    const [draft, setDraft] = useState<{ label: string; text: string } | null>(null);
    const save = (next: readonly SavedPrompt[]): void => onAction({ kind: 'settings.set', key: 'saved_prompts', value: serializePromptLibrary(next) });
    const record = (prompt: SavedPrompt, e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Tab') return;
        e.preventDefault();
        const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        if (bare && (e.key === 'Backspace' || e.key === 'Delete')) {
            const { hotkey: _cleared, ...rest } = prompt;
            setRefused(null);
            save(upsertPrompt(prompts, rest));
            return;
        }
        if (bare && e.key === 'Escape') { e.currentTarget.blur(); return; }
        const accelerator = acceleratorFromPress({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: false }, platform);
        if (accelerator === null) return;
        const problem = hotkeyProblem(accelerator, prompts, prompt.id, platform, bindings);
        if (problem !== null) { setRefused({ id: prompt.id, reason: problem }); return; }
        setRefused(null);
        save(upsertPrompt(prompts, { ...prompt, hotkey: accelerator }));
    };
    return (
        <section data-saved-prompts className="border-t border-[var(--border-1)] px-5 py-3">
            <div className="text-sm font-medium">Saved prompts</div>
            <div className="mb-2 text-xs text-[var(--fg-3)]">Send one from the Command Window (Ctrl K, then p&gt;) or with its own hotkey. It goes to the agent whose chat is open, else the agent on screen, else Genie.</div>
            {prompts.length === 0 && draft === null ? <p className="py-2 text-sm text-[var(--fg-3)]">No saved prompts yet. Add one and it appears under Prompts in the Command Window.</p> : null}
            <ul className="flex flex-col gap-3">
                {prompts.map((prompt) => (
                    <li key={prompt.id} data-saved-prompt={prompt.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-1)] p-3">
                        <div className="flex items-center gap-2">
                            <Input
                                aria-label="Prompt name"
                                defaultValue={prompt.label}
                                className="flex-1"
                                onBlur={(e) => { const label = e.target.value.trim(); if (label && label !== prompt.label) save(upsertPrompt(prompts, { ...prompt, label })); }}
                            />
                            <Input
                                data-prompt-hotkey={prompt.id}
                                aria-label={`Hotkey for ${prompt.label}`}
                                readOnly
                                value={prompt.hotkey ? hotkeyLabel(prompt.hotkey, platform) : ''}
                                placeholder="Click, then press keys"
                                onKeyDown={(e) => record(prompt, e)}
                                className="w-44"
                            />
                            <Button data-action="prompt-remove" size="sm" variant="ghost" onClick={() => save(removePrompt(prompts, prompt.id))}>Remove</Button>
                        </div>
                        <Textarea
                            aria-label={`Text of ${prompt.label}`}
                            defaultValue={prompt.text}
                            rows={2}
                            onBlur={(e) => { const text = e.target.value; if (text.trim() && text !== prompt.text) save(upsertPrompt(prompts, { ...prompt, text })); }}
                        />
                        {refused?.id === prompt.id ? <div data-prompt-refused={prompt.id} className="text-xs text-[var(--danger,#dc2626)]">{refused.reason}</div> : null}
                    </li>
                ))}
                {draft !== null ? (
                    <li data-prompt-draft className="flex flex-col gap-1.5 rounded-lg border border-dashed border-[var(--border-1)] p-3">
                        <Input aria-label="New prompt name" autoFocus placeholder="Name — what you search for" value={draft.label} onValueChange={(label) => setDraft({ ...draft, label })} />
                        <Textarea aria-label="New prompt text" placeholder="What the agent is sent" rows={2} value={draft.text} onValueChange={(text) => setDraft({ ...draft, text })} />
                        <div className="flex gap-2">
                            <Button
                                data-action="prompt-save"
                                size="sm"
                                disabled={!draft.label.trim() || !draft.text.trim()}
                                onClick={() => { save([...prompts, { id: newPromptId(Date.now(), Math.random()), label: draft.label.trim(), text: draft.text }]); setDraft(null); }}
                            >
                                Save prompt
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                        </div>
                    </li>
                ) : null}
            </ul>
            {draft === null ? <Button data-action="prompt-add" size="sm" className="mt-2" onClick={() => setDraft({ label: '', text: '' })}>Add a prompt</Button> : null}
        </section>
    );
}

/** The update half of Settings → General. Absent when the window has no updates bridge — then no control is drawn. */
export interface UpdateCheckProps {
    readonly state: UpdateState | null;
    readonly onCheck: () => void;
}

const updateClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * UPDATES (the owner, 2026-10-13: "where even is the check for updates button?"). First in General:
 * where things stand, and the one verb that asks the feed now. Busy while a check, a download or an
 * install is already running — a second press would only queue the same question.
 */
function UpdatesBlock({ state, onCheck }: UpdateCheckProps) {
    const busy = state !== null && !canCheckNow(state.phase);
    return (
        <div data-updates className="flex items-center gap-4 border-b border-[var(--border-1)] px-5 py-3">
            <div className="flex-1">
                <div className="text-sm font-medium">Updates</div>
                <div data-update-status className="text-xs text-[var(--fg-3)]">{updateStatusLine(state, updateClock)}</div>
            </div>
            <Button data-action="update-check" size="sm" disabled={busy} onClick={onCheck}>{state?.phase === 'checking' ? 'Checking…' : 'Check for updates'}</Button>
        </div>
    );
}

/** The client side of §6.8: this window driving another machine. Absent when the window cannot connect. */
export interface RemoteConnectProps {
    /** `null` until a connection has been attempted. */
    readonly state: RemoteState | null;
    /** Host URLs this device already holds a token for — no PIN needed. */
    readonly remembered: readonly string[];
    readonly onConnect: (input: { host: string; pin: string; label: string }) => void;
    readonly onDisconnect: () => void;
    /** The hosts this device has connected to (Tynn #819), newest first; absent or empty = no list. */
    readonly known?: readonly KnownHost[] | undefined;
    /** Open a known host IN ITS OWN WINDOW (Genie 1's remote.open) — the local Genie stays open. */
    readonly onOpenHost?: ((url: string) => void) | undefined;
    /** Forget a host and its token: the next connection needs the PIN again. */
    readonly onForgetHost?: ((url: string) => void) | undefined;
    /** This window's link to its host dropped: connect again with the token it holds. */
    readonly onReconnect?: (() => void) | undefined;
    /** The clock "last connected" is read against (tests pass a fixed one). */
    readonly now?: number | undefined;
    /** Upgrade the connected host (Genie 1's remote.upgradeHost, Tynn #822) — offered to its OWNER only. */
    readonly onUpgradeHost?: (() => void) | undefined;
    /** Where an upgrade stands (core/host-upgrade.ts); absent = none running. */
    readonly upgrade?: HostUpgradeStep | null | undefined;
    /** The workstations Tynn says this person can see (Tynn #837); absent/`null` = not asked. */
    readonly tynnWorkstations?: TynnWorkstationList | null | undefined;
    /** Open a Tynn workstation in its own window, over the Tynn relay. */
    readonly onOpenWorkstation?: ((workstation: TynnWorkstationRow) => void | Promise<unknown>) | undefined;
    /** Paste a share link instead (genie#1278 C1): opens the Command Window's share-link box. */
    readonly onOpenLink?: (() => void) | undefined;
    /** A pilot only (genie#1278 W6): change a workstation's role with an authenticator code. */
    readonly onSetRole?: ((workstation: TynnWorkstationRow, role: 'pilot' | 'drone', code: string) => Promise<RoleChange>) | undefined;
    /** Read Tynn's list again, and where that read stands (M0 finding 1; the title bar's menu and ⌘K use them). */
    readonly onRefresh?: (() => void) | undefined;
    readonly refresh?: ConnectProgress | undefined;
}

/** An upgrade's step, in words, for the host it is upgrading. */
function upgradeWords(step: HostUpgradeStep, host: string): string {
    switch (step.kind) {
        case 'checking': return `Asking ${host} for an update…`;
        case 'up-to-date': return `${host} is up to date.`;
        case 'downloading': return `${host} is downloading ${step.version}…`;
        case 'installing': return `${host} is installing ${step.version}…`;
        case 'reconnecting': return `${host} is restarting on ${step.version} — reconnecting…`;
        case 'done': return `${host} is on ${step.version}.`;
        case 'lost': return `${host} did not come back after installing ${step.version}. Check that machine.`;
        case 'failed': return `Not upgraded: ${step.reason}.`;
    }
}

/**
 * "DRIVE ANOTHER MACHINE" — a host, a PIN (or a remembered token), a label for this screen. While
 * connected: who you are driving and Disconnect. A refusal from the host is shown where it was caused.
 */
export function ConnectRemote({ state, remembered, onConnect, onDisconnect, known = [], onOpenHost, onForgetHost, onReconnect, now = Date.now(), onUpgradeHost, upgrade = null, tynnWorkstations = null, onOpenWorkstation, onSetRole }: RemoteConnectProps) {
    const [opening, openWorkstation] = useOpenProgress(onOpenWorkstation);
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    // An upgrade in flight is said in place of its button — connected or not: the link DROPS while the host restarts.
    const upgrading = upgrade !== null && upgrade.kind !== 'up-to-date' && upgrade.kind !== 'done' && upgrade.kind !== 'failed' && upgrade.kind !== 'lost';
    const upgradeLine = upgrade && state?.host ? <span data-host-upgrade={upgrade.kind} className="text-xs text-[var(--fg-3)]">{upgradeWords(upgrade, state.host)}</span> : null;
    if (state?.connected && state.host) {
        return (
            <div data-remote-connected className="flex flex-wrap items-center gap-3 text-sm">
                <span>Driving {state.host} — {state.viewOnly ? 'view only' : state.locked ? 'locked' : state.driving ? 'you hold the baton' : state.driver ? `${state.driver} is driving` : 'nobody is driving'}</span>
                {upgradeLine}
                {/* The host's OWNER only: a shared workspace cannot change the host itself (main/remote-host.ts refuses it). */}
                {onUpgradeHost && state.isOwner && !upgrading ? <Button size="xs" type="button" data-action="upgrade-host" className={`ml-auto ${button}`} onClick={onUpgradeHost}>Upgrade {state.host}</Button> : null}
                <Button size="xs" type="button" className={`${onUpgradeHost && state.isOwner && !upgrading ? '' : 'ml-auto '}${button}`} onClick={onDisconnect}>Disconnect</Button>
            </div>
        );
    }
    // The link to a host dropped (Genie 1's remote.reconnect): one click back, with the token this device holds.
    const reconnect = state !== null && !state.connected && state.host && onReconnect ? (
        <Button size="xs" type="button" data-action="reconnect" onClick={onReconnect} className={button}>Reconnect to {state.host}</Button>
    ) : null;
    // THE KNOWN HOSTS (Genie 1's remote.known): each opens in its own window; Forget drops it and its token.
    const list = known.length > 0 ? (
        <ul data-known-hosts="" className="flex flex-col gap-1">
            {known.map((h) => (
                <li key={h.url} data-known-host={h.url} className="flex items-center gap-2 rounded-lg border border-[var(--border-1)] px-3 py-2 text-[13px]">
                    <span className="font-medium">{h.name ?? h.url.replace(/^wss?:\/\//, '').replace(/\/genie$/, '')}</span>
                    <span className="truncate font-mono text-[11px] text-[var(--fg-4)]">{h.url}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-[var(--fg-3)]">{h.lastConnectedAt !== null ? agoText(h.lastConnectedAt, now) : h.paired ? 'paired' : ''}</span>
                    {onOpenHost ? <Button size="xs" type="button" data-action="open-host" onClick={() => onOpenHost(h.url)} className={button}>Open</Button> : null}
                    {onForgetHost ? <Button size="xs" type="button" data-action="forget-host" onClick={() => onForgetHost(h.url)} className={button}>Forget</Button> : null}
                </li>
            ))}
        </ul>
    ) : null;
    // YOUR TYNN WORKSTATIONS — THE MAIN WAY (Genie 1's Hosts picker, Tynn #837; genie#1278 C1): each one Tynn says you may
    // reach opens in its own window over the Tynn relay, with its progress; one you may not is shown, and says why. None,
    // or Tynn could not be asked: the steps to take on the other machine (ConnectMenu.tsx), never an empty space.
    const tynnList = tynnWorkstations === null ? null : (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--fg-3)]">Your Tynn workstations</span>
            <TynnWorkstationRows list={tynnWorkstations} onOpenWorkstation={openWorkstation} opening={opening} onSetRole={onSetRole} />
        </div>
    );
    // Host and PIN over the tailnet is the OTHER way: folded under the Tynn list. Open when it is the only way (Tynn was
    // not asked from this window) or when it has something to say (a refusal is never folded away).
    const tailnetOpen = tynnWorkstations === null || Boolean(state?.lastRefusal);
    return (
        <div className="flex flex-col gap-3">
        {upgradeLine}
        {upgrading ? null : reconnect}
        {tynnList}
        {list}
        <details data-connect-tailnet="" open={tailnetOpen} className="flex flex-col gap-2">
        <summary className="cursor-pointer text-xs font-medium text-[var(--fg-3)]">Over your tailnet, with a host and PIN</summary>
        <form
            data-form="connect-remote"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                onConnect({ host: String(data.get('host') ?? ''), pin: String(data.get('pin') ?? ''), label: String(data.get('label') ?? '') });
            }}
        >
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Host</span>
                <Input name="host" list="remote-hosts" placeholder="studio.your-tailnet.ts.net:7421" defaultValue={remembered[0]?.replace(/^wss?:\/\//, '').replace(/\/genie$/, '') ?? ''} />
                {remembered.length > 0 ? (
                    <datalist id="remote-hosts">
                        {remembered.map((h) => <option key={h} value={h.replace(/^wss?:\/\//, '').replace(/\/genie$/, '')} />)}
                    </datalist>
                ) : null}
            </label>
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">PIN (blank if this device is already paired)</span>
                <Input name="pin" inputMode="numeric" placeholder="482913" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">This screen’s name</span>
                <Input name="label" placeholder="Office laptop" />
            </label>
            <Button size="xs" type="submit" className={button}>Connect</Button>
            {state?.lastRefusal ? <div data-problem="connect" className="basis-full text-xs text-[var(--danger)]">{state.lastRefusal}</div> : null}
        </form>
        </details>
        </div>
    );
}

/**
 * INTEGRATIONS (§6.9). Tynn is OPTIONAL: signed out shows the sign-in and every Tynn-gated row still
 * listed, annotated with the route; signed in shows Sign out. GitHub is its own card (GithubBlock). A workspace's agent files — their status and its Sync now — are in that workspace's own Settings; this
 * section says so (the owner, 2026-10-13: a picker here, above Genie start's record of every workspace, read as
 * "I chose one workspace but it updated all workspaces").
 */
/**
 * SIGN IN TO TYNN — Genie 1's card (the owner, 2026-10-19: "this is not how we handle tynn logins. Look at Genie 1").
 * One button opens Tynn in the browser; the host is shown; the code comes back by itself (genie://) or is pasted. The
 * link stays on screen for a machine without a browser. There is no token to type. Signed in: who, and Sign out.
 */
function TynnSignIn({ tynn, onAction }: { tynn: NonNullable<FeatureData['integrations']>['tynn']; onAction: SurfaceProps['onAction'] }) {
    // Copied through main's clipboard, and it says whether it landed (CopyText).
    const link = useCopyText();
    return (
        <div data-tynn-sign-in="" className="flex flex-col gap-2 text-sm">
            <div className="flex min-w-0 items-center gap-1.5">
                <span data-tynn-host={tynn.host} className="flex-1 truncate font-mono text-xs text-[var(--fg-3)]" title={tynn.host}>{tynn.host}</span>
            </div>
            {tynn.user ? (
                <div className="flex items-center gap-2">
                    <span className="flex-1">Signed in as <strong>{tynn.user.name}</strong> <span className="text-[var(--fg-3)]">{tynn.user.email}</span></span>
                    <Button type="button" data-action="tynn-sign-out" variant="ghost" size="sm" onClick={() => onAction({ kind: 'integrations.tynnSignOut' })}>Sign out</Button>
                </div>
            ) : (
                <>
                    <span className="text-[var(--fg-3)]">Genie is fully usable signed out; Tynn adds identity and work-item sync. Rows that need it are listed below, annotated, never hidden.</span>
                    <div><Button type="button" data-action="tynn-sign-in" size="sm" onClick={() => onAction({ kind: 'integrations.tynnSignIn' })}>Open Tynn in your browser</Button></div>
                    {tynn.signInUrl ? (
                        <div data-tynn-sign-in-url={tynn.signInUrl} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-1)] p-2.5">
                            <span className="text-xs text-[var(--fg-3)]">No browser on this machine? Copy this link, open it on any device, sign in, then paste the code below.</span>
                            <div className="flex min-w-0 items-center gap-1.5">
                                <span className="flex-1 truncate font-mono text-xs text-[var(--fg-3)]" title={tynn.signInUrl}>{tynn.signInUrl}</span>
                                <Button type="button" data-action="tynn-copy-sign-in-url" variant="ghost" size="xs" onClick={() => { void link.copy(tynn.signInUrl ?? ''); }}>{copyWords(link.state, 'Copy')}</Button>
                                <CopyAnnounce state={link.state} />
                            </div>
                        </div>
                    ) : null}
                    <form data-form="tynn-code" className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; onAction({ kind: 'integrations.tynnCode', code: String(new FormData(form).get('code') ?? '') }); form.reset(); }}>
                        <Input name="code" autoComplete="off" spellCheck={false} placeholder="Paste sign-in code from Tynn" aria-label="Sign-in code" />
                        <Button type="submit" size="sm">I have a code</Button>
                    </form>
                </>
            )}
            {tynn.message ? <span data-tynn-message="" className="text-xs text-[var(--danger)]">{tynn.message}</span> : null}
        </div>
    );
}

/** The keyring card's button, per state: what it does, and what it says while it does it. */
const KEYRING_ACTION: Record<KeyringView['state'], string> = { 'not-installed': 'Install keyring', 'not-running': 'Start keyring', 'restart-needed': 'Restart Genie', refused: UNLOCK_WORDS.button };
const KEYRING_STEP: Record<NonNullable<KeyringView['step']>, string> = { installing: 'Installing…', starting: 'Starting…', restarting: 'Restarting…', unlocking: 'Unlocking…' };
/** One line per state: why the sign-in waits, in the fewest words (the owner: reduce reading). */
const KEYRING_LINE: Record<KeyringView['state'], string> = {
    'not-installed': 'Genie needs a keyring to keep your sign-ins safe. This computer has none.',
    'not-running': 'Genie needs a keyring to keep your sign-ins safe. Yours is installed but not running.',
    'restart-needed': 'Keyring ready. Restart Genie to use it.',
    refused: 'Genie needs a keyring to keep your sign-ins safe. Yours is locked.',
};

/**
 * NO KEYRING, THE CARD (the owner, 2026-11-01): one line saying why the sign-in waits, ONE button whose words say what it
 * does (Install keyring / Start keyring / Restart Genie / Check again), busy with the step while it runs, then the
 * failure in words with Retry, and the command to run by hand with a Copy when Genie cannot. Genie never asks for a
 * password: Install opens the system's own prompt. The sign-in is not offered behind it: nothing could keep it.
 */
function KeyringCard({ keyring, onAction }: { keyring: KeyringView; onAction: SurfaceProps['onAction'] }) {
    const command = useCopyText();
    const busy = keyring.step !== null;
    const unlocking = keyring.step === 'unlocking';
    // A locked keyring is asked again by the same button: Unlock, never Retry or instructions (Tynn story #388).
    const label = busy ? KEYRING_STEP[keyring.step!] : keyring.failure && keyring.state !== 'refused' ? 'Retry' : KEYRING_ACTION[keyring.state];
    return (
        <div data-keyring-card={keyring.state} className="flex flex-col gap-2 rounded-md border border-[var(--border-1)] p-3 text-sm">
            <span>{unlocking ? UNLOCK_WORDS.asking : KEYRING_LINE[keyring.state]}</span>
            {keyring.state === 'not-installed' ? <span className="text-xs text-[var(--fg-3)]">Installs {keyring.packages}. Your system asks for your password.</span> : null}
            <div className="flex items-center gap-2">
                <Button type="button" data-action="keyring-fix" size="sm" disabled={busy} loading={busy} onClick={() => onAction({ kind: 'keyring.fix' })}>{label}</Button>
                {unlocking ? <Button type="button" data-action="keyring-cancel" variant="ghost" size="sm" onClick={() => onAction({ kind: 'keyring.cancel' })}>Cancel</Button> : null}
            </div>
            {keyring.failure ? <span data-keyring-failure="" role="status" className="text-xs text-[var(--danger)]">{keyring.failure}</span> : null}
            {keyring.failure && keyring.manual ? (
                <div data-keyring-manual={keyring.manual} className="flex min-w-0 items-center gap-1.5">
                    <span className="flex-1 truncate font-mono text-xs" title={keyring.manual}>{keyring.manual}</span>
                    <Button type="button" data-action="keyring-copy-command" variant="ghost" size="xs" onClick={() => { void command.copy(keyring.manual ?? ''); }}>{copyWords(command.state, 'Copy')}</Button>
                    <CopyAnnounce state={command.state} />
                </div>
            ) : null}
        </div>
    );
}

/** The Settings pages' card: a titled block, one per concern (Genie 1's SetSection). */
function SetSection({ title, desc, children, ...rest }: { title: string; desc?: string; children: React.ReactNode } & Record<`data-${string}`, string>) {
    return (
        <section {...rest} className="flex flex-col gap-2 border-b border-[var(--border-1)] px-6 py-4">
            <div>
                <h2 className="text-sm font-semibold">{title}</h2>
                {desc ? <p className="text-xs text-[var(--fg-3)]">{desc}</p> : null}
            </div>
            {children}
        </section>
    );
}

/** AGENT MCP (§6.4, §6.9): where Genie's own MCP server listens, whether the boot probe answered, the tools every agent gets. */
function McpServerBlock({ integrations }: { integrations: FeatureData['integrations'] }) {
    if (integrations === null) return <div data-integrations=""><Skeletons rows={3} /></div>;
    return <McpServerPanel url={integrations.mcp.url} verified={integrations.mcp.verified} tools={integrations.mcp.tools ?? []} />;
}

/**
 * TYNN — the sign-in card (Genie 1's) and the rows Tynn gates. Tynn is tynn.ai (core/tynn.ts TYNN_HOST): there is no
 * host to change (the owner, 2026-10-21: "tynn is not a changeable host").
 */
function TynnBlock({ integrations, onAction }: { integrations: FeatureData['integrations']; onAction: SurfaceProps['onAction'] }) {
    if (integrations === null) return <div data-integrations=""><Skeletons rows={2} /></div>;
    return (
        <div data-integrations="" className="flex flex-col gap-2">
            {integrations.keyringNotice ? <p data-keyring-notice="" role="status" className="text-xs text-[var(--fg-2)]">{integrations.keyringNotice}</p> : null}
            {integrations.keyring && !integrations.tynn.user ? <KeyringCard keyring={integrations.keyring} onAction={onAction} /> : <TynnSignIn tynn={integrations.tynn} onAction={onAction} />}
                        <ul className="mt-2 divide-y divide-[var(--border-1)]">
                            {integrations.gated.map((row) => (
                                <li key={row.id} data-gated={row.id} data-gated-enabled={row.enabled ? 'true' : 'false'} className="flex items-center gap-3 py-1.5 text-sm">
                                    <span className={row.enabled ? '' : 'text-[var(--fg-3)]'}>{row.label}</span>
                                    {row.note ? <span className="text-xs text-[var(--fg-3)]">{row.note}</span> : null}
                                </li>
                            ))}
                        </ul>
        </div>
    );
}

/**
 * GITHUB — Genie 1's card, for real (beta.33 item 25). The owner (2026-10-20): "our Github integration and login needs to
 * be way easier than this and it needs to be functional not some dumb list … I already had github setup with this app
 * with genie 1 so why is it not functional anymore?"
 *
 * Signed out: ONE button. Signing in: GitHub's code, large, with Copy, and its page (opened already; again on a click) —
 * Genie waits for GitHub by itself and the card changes when it lands. Signed in: who,
 * every account the app is installed on with its repositories and the permissions GitHub GRANTED, each with its own
 * Configure; Install on more repositories; what those permissions let Genie do; Check again; Sign out. Everything here is
 * what main read from GitHub (main/github-account.ts); the token never reaches this window.
 */
function GithubBlock({ integrations, onAction }: { integrations: FeatureData['integrations']; onAction: SurfaceProps['onAction'] }) {
    // Copied through main's clipboard, and it says whether it landed (CopyText).
    const codeCopy = useCopyText();
    if (integrations === null) return <div data-integrations=""><Skeletons rows={2} /></div>;
    const gh = integrations.github;
    const message = gh.message ? <p data-github-message="" className="text-xs text-[var(--danger)]">{gh.message}</p> : null;
    const open = (target: Extract<FeatureAction, { kind: 'integrations.githubOpen' }>['target']) => onAction({ kind: 'integrations.githubOpen', target });

    if (gh.status === 'signing-in' && gh.device) {
        const code = gh.device.userCode;
        return (
            <div data-integrations="" data-github-status="signing-in" className="flex flex-col gap-3 text-sm">
                <p>Enter this code on GitHub’s page — it opened in your browser:</p>
                <div className="flex items-center gap-3">
                    <span data-github-code={code} className="select-all rounded-md border border-[var(--border-1)] px-3 py-1.5 font-mono text-2xl tracking-widest">{code}</span>
                    <Button type="button" data-action="github-copy-code" variant="ghost" size="sm" onClick={() => { void codeCopy.copy(code); }}>{copyWords(codeCopy.state, 'Copy')}</Button>
                    <CopyAnnounce state={codeCopy.state} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" data-action="github-open-device" size="sm" onClick={() => open({ page: 'device' })}>Open GitHub again</Button>
                    <span className="font-mono text-xs text-[var(--fg-3)]">{gh.device.verificationUri}</span>
                </div>
                <p className="text-[var(--fg-3)]">Waiting for GitHub — this changes by itself once you approve Genie AOS there.</p>
                <div><Button type="button" data-action="github-cancel" variant="ghost" size="sm" onClick={() => onAction({ kind: 'integrations.githubCancelSignIn' })}>Cancel</Button></div>
                {message}
            </div>
        );
    }

    if (gh.status === 'signed-out' || gh.user === null) {
        return (
            <div data-integrations="" data-github-status="signed-out" className="flex flex-col gap-2 text-sm">
                <p className="text-[var(--fg-3)]">One click: GitHub shows a code, you approve the Genie AOS app in your browser, and Genie reads where it is installed. No token to paste.</p>
                {/* No keyring: nothing could keep the GitHub sign-in either — the same card, in its place. */}
                {integrations.keyringNotice ? <p data-keyring-notice="" role="status" className="text-xs text-[var(--fg-2)]">{integrations.keyringNotice}</p> : null}
                {integrations.keyring ? <KeyringCard keyring={integrations.keyring} onAction={onAction} /> : <div><Button type="button" data-action="github-sign-in" size="sm" onClick={() => onAction({ kind: 'integrations.githubSignIn' })}>Sign in with GitHub</Button></div>}
                {message}
                {githubCapabilityList(gh.capabilities)}
            </div>
        );
    }

    const expired = gh.status === 'expired';
    return (
        <div data-integrations="" data-github-status={gh.status} className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2">
                <Avatar size="sm" fallback={gh.user.login.slice(0, 2).toUpperCase()} alt={gh.user.login} />
                <span className="flex-1">Signed in as <strong>{gh.user.login}</strong>{gh.user.name ? <span className="text-[var(--fg-3)]"> {gh.user.name}</span> : null}</span>
                <Button type="button" data-action="github-refresh" variant="ghost" size="sm" disabled={gh.checking} onClick={() => onAction({ kind: 'integrations.githubRefresh' })}>{gh.checking ? 'Checking…' : 'Check again'}</Button>
                <Button type="button" data-action="github-sign-out" variant="ghost" size="sm" onClick={() => onAction({ kind: 'integrations.githubSignOut' })}>Sign out</Button>
            </div>
            {message}
            {expired ? <div><Button type="button" data-action="github-sign-in" size="sm" onClick={() => onAction({ kind: 'integrations.githubSignIn' })}>Sign in again</Button></div> : (
                <>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Where the Genie AOS app is installed</h3>
                            <Button type="button" data-action="github-install" size="sm" onClick={() => open({ page: 'install' })}>Install on more repositories</Button>
                        </div>
                        {gh.installations === null ? (
                            <div data-github-installations="reading"><Skeletons rows={2} /></div>
                        ) : gh.installations.length === 0 ? (
                            <p data-github-installations="0" className="text-[var(--fg-3)]">The app is not installed on any account yet. Install it on the accounts and repositories Genie should reach.</p>
                        ) : (
                            <ul data-github-installations={gh.installations.length} className="flex flex-col divide-y divide-[var(--border-1)] rounded-md border border-[var(--border-1)]">
                                {gh.installations.map((i) => (
                                    <li key={i.id} data-github-installation={i.account} className="flex flex-col gap-1.5 px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            <strong className="flex-1">{i.account}</strong>
                                            <Badge variant="soft" size="sm" color="zinc">{i.isOrg ? 'Organization' : 'Personal'}</Badge>
                                            <Button type="button" data-action={`github-configure-${i.id}`} variant="ghost" size="xs" onClick={() => open({ page: 'installation', installationId: i.id })}>Configure</Button>
                                        </div>
                                        <span className="text-xs text-[var(--fg-3)]">{i.selection === 'all' ? `All repositories${i.repoCount !== null ? ` (${i.repoCount})` : ''}` : `${i.repoCount ?? i.repos?.length ?? 0} selected ${(i.repoCount ?? i.repos?.length ?? 0) === 1 ? 'repository' : 'repositories'}`}</span>
                                        {i.repos && i.repos.length > 0 ? <span className="font-mono text-xs">{i.repos.join(', ')}</span> : null}
                                        <div className="flex flex-wrap gap-1">
                                            {Object.entries(i.permissions).map(([name, level]) => (
                                                <span key={name} data-github-permission={`${name}:${level}`}><Badge variant="soft" size="sm">{`${name.replace(/_/g, ' ')}: ${level}`}</Badge></span>
                                            ))}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    {githubCapabilityList(gh.capabilities)}
                    <p className="text-xs text-[var(--fg-3)]">Sign out forgets the sign-in on this machine. To revoke Genie AOS from your GitHub account entirely, <Button type="button" data-action="github-open-authorizations" variant="ghost" size="xs" onClick={() => open({ page: 'authorizations' })}>open GitHub’s authorized apps</Button>.</p>
                </>
            )}
        </div>
    );
}

/** What GitHub's permissions let Genie do, each enabled or saying why not (core/github.ts githubCapabilities). */
function githubCapabilityList(rows: readonly GithubCapability[]) {
    return (
        <div className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">What Genie can do with GitHub</h3>
            <ul className="flex flex-col gap-1">
                {rows.map((r) => (
                    <li key={r.id} data-github-capability={r.id} data-enabled={r.enabled ? 'true' : 'false'} className="flex items-baseline gap-2">
                        <Badge variant="soft" size="sm" color={r.enabled ? 'emerald' : 'amber'}>{r.enabled ? 'yes' : 'not yet'}</Badge>
                        <span className={r.enabled ? '' : 'text-[var(--fg-3)]'}>{r.label}</span>
                        {r.note ? <span className="text-xs text-[var(--fg-3)]">{r.note}</span> : null}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Upgrade the host this window drives (its owner only): the button, or where an upgrade in flight has got to. */
function HostUpgradeRow({ host, upgrade, onUpgradeHost }: { host: string; upgrade: HostUpgradeStep | null; onUpgradeHost: () => void }) {
    const upgrading = upgrade !== null && upgrade.kind !== 'up-to-date' && upgrade.kind !== 'done' && upgrade.kind !== 'failed' && upgrade.kind !== 'lost';
    return (
        <div data-remote-host-upgrade="" className="flex flex-wrap items-center gap-3 text-sm">
            {upgrade ? <span data-host-upgrade={upgrade.kind} className="text-xs text-[var(--fg-3)]">{upgradeWords(upgrade, host)}</span> : null}
            {upgrading ? null : <Button size="xs" type="button" data-action="upgrade-host" className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={onUpgradeHost}>Upgrade {host}</Button>}
        </div>
    );
}

/**
 * TAILSCALE (Tynn #821; Genie 1's tailscale.status / install / up): remote access runs over the tailnet, so where Tailscale
 * stands, and the one action that moves it on. Main reads Tailscale again when this row opens and when its window regains
 * focus, and keeps reading on its own while Tailscale is not connected (Tynn #749): installed or signed in from Tailscale's
 * own window, the row moves on without a relaunch. While Genie's Install is under way it is the same button, busy and
 * disabled: nothing moves, and a second click opens no second installer (Tynn #748).
 */
function TailscaleRow({ tailscale, outcome, host, browse, onAction, button }: { tailscale: NonNullable<RemoteSection['tailscale']>; outcome: string | null; host: string; browse: boolean; onAction: SurfaceProps['onAction']; button: string }) {
    const askRead = useRef(onAction);
    askRead.current = onAction;
    useEffect(() => {
        const read = (): void => { askRead.current({ kind: 'tailscale.refresh' }); };
        read();
        window.addEventListener('focus', read);
        return () => window.removeEventListener('focus', read);
    }, []);
    const installing = tailscale.installing === true;
    return (
        <div data-tailscale={tailscale.state} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">Tailscale</span>
            {tailscale.state === 'running' ? (
                <>
                    <span>Connected as <span className="font-mono">{tailscale.self?.dnsName ?? tailscale.self?.hostname ?? host}</span></span>
                    {browse ? <span className="text-xs text-[var(--fg-3)]">{tailscale.peers.length} {tailscale.peers.length === 1 ? 'device' : 'devices'} on your tailnet</span> : null}
                </>
            ) : (
                <>
                    <span className="text-[var(--fg-2)]">{tailscale.remedy?.message ?? (tailscale.state === 'needs-login' ? 'This machine is not on your tailnet yet.' : 'Tailscale is not ready.')}</span>
                    {tailscale.remedy?.command ? <code className="basis-full rounded-md bg-[var(--bg-2)] px-2 py-1 font-mono text-xs">{tailscale.remedy.command}</code> : null}
                    {tailscale.state === 'absent' ? <Button size="xs" type="button" data-action="tailscale-install" data-busy={installing ? 'true' : undefined} loading={installing} disabled={installing} className={button} onClick={() => onAction({ kind: 'tailscale.install' })}>Install Tailscale</Button> : null}
                    {tailscale.state === 'needs-login' ? <Button size="xs" type="button" data-action="tailscale-up" className={button} onClick={() => onAction({ kind: 'tailscale.up' })}>Connect</Button> : null}
                </>
            )}
            {outcome ? <span data-tailscale-outcome="" className="basis-full text-xs text-[var(--fg-3)]">{outcome}</span> : null}
        </div>
    );
}

/**
 * THE WINDOWS FIREWALL ROW (Tynn #685; the owner: "If it's already allowed I should see that it is already allowed and I
 * should have a button for clearing that rule"). It draws main's reading of Genie's rule from Windows:
 *  - there and letting the port in: "Allowed", with what Windows reports, and Remove;
 *  - there but not letting it in (turned off, blocking, another port): why, Allow to put it right, and Remove;
 *  - there, in words Genie cannot read: its lines as Windows printed them, and Remove;
 *  - absent, unreadable or not read yet: Allow (offer the fix rather than hide a missing rule).
 * Allow is offered only while Remote access is on (there is nothing to let in otherwise); the rule and Remove are shown
 * whatever the switch says, because the rule outlives it.
 */
function FirewallRow({ rule, enabled, outcome, onAction, button }: { rule: FirewallRuleView | null; enabled: boolean; outcome: string | null; onAction: SurfaceProps['onAction']; button: string }) {
    // What Windows has NOW: ask main to read again when the page opens and when its window regains focus (Tynn #685).
    // Main debounces the read, so this never spawns netsh in a burst. Once per mount, not per snapshot.
    const askRead = useRef(onAction);
    askRead.current = onAction;
    useEffect(() => {
        const read = (): void => { askRead.current({ kind: 'remote.readFirewall' }); };
        read();
        window.addEventListener('focus', read);
        return () => window.removeEventListener('focus', read);
    }, []);
    const present = rule?.state === 'present' ? rule : null;
    const state = !present ? (rule?.state === 'absent' ? 'absent' : rule?.state === 'unknown' ? 'unknown' : 'unread')
        : present.covers === true ? 'allowed' : present.covers === false ? 'not-allowing' : 'present';
    const allowButton = <Button size="xs" type="button" icon="shield-check" data-action="remote-firewall" className={button} onClick={() => onAction({ kind: 'remote.allowFirewall' })}>Allow through Windows Firewall</Button>;
    const removeButton = <Button size="xs" type="button" icon="trash-2" data-action="remote-firewall-remove" className={button} onClick={() => onAction({ kind: 'remote.removeFirewall' })}>Remove</Button>;
    const reported = (r: FirewallRuleFacts): string => [
        `${r.protocol ?? ''} ${r.localPort ?? ''}`.trim(),
        r.remoteIp ? `from ${r.remoteIp}` : '',
        r.profiles ? `profiles ${r.profiles}` : '',
    ].filter(Boolean).join(', ');
    const why = (r: FirewallRuleFacts, port: number): string =>
        r.enabled === false ? 'it is turned off'
            : r.allow === false ? 'it blocks the port'
            : r.inbound === false ? 'it is for outgoing traffic'
            : r.protocol !== null && r.protocol !== 'TCP' && r.protocol !== 'Any' ? `it is for ${r.protocol}, not TCP`
            : r.localPort !== null ? `it lets in ${r.localPort}, and remote access uses ${port}` : 'Windows does not say';
    return (
        <div data-firewall-rule={state} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">Windows Firewall</span>
            {state === 'allowed' && present ? (
                <>
                    <span className="flex items-center gap-1.5 text-[var(--success)]"><Icon name="shield-check" size="sm" />Allowed through Windows Firewall</span>
                    <span data-firewall-reported="" className="font-mono text-xs text-[var(--fg-3)]">{present.rules.map(reported).join('; ')}</span>
                    {removeButton}
                </>
            ) : state === 'not-allowing' && present ? (
                <>
                    <span className="text-[var(--warning)]">{`Genie’s rule does not let remote access in: ${present.rules.map((r) => why(r, present.port)).join('; ')}.`}</span>
                    <span data-firewall-reported="" className="font-mono text-xs text-[var(--fg-3)]">{present.rules.map(reported).join('; ')}</span>
                    {enabled ? allowButton : null}
                    {removeButton}
                </>
            ) : state === 'present' && present ? (
                <>
                    <span>Windows has Genie’s rule:</span>
                    <span data-firewall-reported="" className="font-mono text-xs text-[var(--fg-3)]">{present.rules.map((r) => r.fields.map((f) => `${f.label} ${f.value}`).join(' · ')).join('; ')}</span>
                    {enabled ? allowButton : null}
                    {removeButton}
                </>
            ) : (
                <>
                    {state === 'absent' ? <span className="text-[var(--fg-2)]">No rule lets remote access through yet.</span> : null}
                    {rule?.state === 'unknown' ? <span className="text-[var(--fg-2)]">{`Windows Firewall could not be read: ${rule.reason}`}</span> : null}
                    {enabled ? allowButton : null}
                </>
            )}
            {outcome ? <span data-firewall-outcome="" className="basis-full text-xs text-[var(--fg-3)]">{outcome}</span> : null}
        </div>
    );
}

/**
 * REMOTE ACCESS (§6.8) — the PIN this screen shows, the paired devices (Revoke each), who is connected
 * and who is driving, the lock as one button. No transport → the section says devices cannot connect. Sharing is a Tynn
 * link, made from a workspace's Share (ShareWorkspaceModal); the old local share link here was removed (audit M-d).
 */
/** When the relay link was lost (Tynn #940): the time today, or the day and time when it was earlier. */
function sinceWords(since: number, now: number = Date.now()): string {
    const at = new Date(since);
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function RemoteAccess({ remote, workspaces, onAction, connect, now = Date.now() }: { remote: FeatureData['remote']; workspaces: readonly { id: string; path: string; name?: string | undefined }[]; onAction: SurfaceProps['onAction']; connect?: RemoteConnectProps | undefined; now?: number | undefined }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    // The QR carries the PAGE a phone opens (§6.8), with the PIN in its hash — a socket URL is nothing a phone can scan into.
    const pairUrl = mobilePageUrl(remote?.url ?? null) ?? remote?.url ?? '';
    // What Tynn says this machine is (main reads it from Tynn; genie#1278 W5). A drone offers no browsing.
    const role = remote?.tynnWorkstation?.role ?? null;
    const browse = mayBrowse(role);
    return (
        <section data-remote className="flex flex-col gap-3 border-t border-[var(--border-1)] px-5 py-3">
            <h2 className="text-sm font-semibold">Remote access</h2>
            {/* THIS MACHINE'S OWN, OR THE HOST THIS WINDOW DRIVES (Tynn #640; the owner: "that is for settings on the host I am
                connected to"). Connecting to other machines is the title bar's host picker alone (Genie 1's HostsButton); a
                connected window's Disconnect is its host badge's. Upgrading the host this window drives is about that host. */}
            {connect?.state?.connected === true && connect.state.host && connect.state.isOwner && connect.onUpgradeHost ? (
                <HostUpgradeRow host={connect.state.host} upgrade={connect.upgrade ?? null} onUpgradeHost={connect.onUpgradeHost} />
            ) : null}
            {remote === null && connect?.state?.connected === true && connect.state.host ? (
                // A host with no window open sends no Remote access of its own yet (#1231): said, never a skeleton for ever.
                <p data-remote-host-settings="unavailable" className="text-xs text-[var(--fg-3)]">{`Open Genie on ${connect.state.host} to see its settings.`}</p>
            ) : remote === null ? (
                <Skeletons rows={3} />
            ) : (
                <>
                    {/* THE SWITCH (Tynn #820; the owner: "Off by default", as Genie 1 had it): off, nothing listens. It is ALSO what
                        makes this machine reachable through the Tynn relay (main.ts relayAfterSwitch), so it says Tynn first. */}
                    <div data-remote-enabled={remote.enabled ? 'true' : 'false'} className="flex flex-wrap items-center gap-3 text-sm">
                        <Switch checked={remote.enabled} onCheckedChange={(checked) => onAction({ kind: 'settings.set', key: 'remote_access', value: checked })} aria-label="Let your other machines reach this Genie" />
                        <span>{remote.enabled ? `Your other machines can reach ${remote.host} through Tynn, and devices on your tailnet.` : `Remote access is off: your other machines cannot reach ${remote.host} through Tynn or your tailnet.`}</span>
                        {remote.enabled ? <Button size="xs" type="button" data-action="remote-restart" className={button} onClick={() => onAction({ kind: 'remote.restart' })}>Restart</Button> : null}
                    </div>
                    {/* WINDOWS FIREWALL (Tynn #685): whether Genie's rule is there, as Windows reports it; Remove when it is. */}
                    {remote.firewall ? <FirewallRow rule={remote.firewallRule ?? null} enabled={remote.enabled} outcome={remote.firewallOutcome ?? null} onAction={onAction} button={button} /> : null}
                    {/* TAILSCALE (Tynn #821; Genie 1's tailscale.status / install / up): remote access runs over the tailnet, so
                        where Tailscale stands, and the one action that moves it on. */}
                    {remote.tailscale ? <TailscaleRow tailscale={remote.tailscale} outcome={remote.tailscaleOutcome ?? null} host={remote.host} browse={browse} onAction={onAction} button={button} /> : null}
                    {/* THE TYNN NETWORK (Tynn #836): this machine registered with Tynn as a workstation — what a share, the
                        relay and the Tynn workstations list stand on — or why it is not. */}
                    {remote.tynnWorkstation ? (
                        <div data-tynn-workstation={remote.tynnWorkstation.registered ? 'registered' : 'unregistered'} className="flex flex-wrap items-center gap-3 text-sm">
                            <span className="font-medium">Tynn</span>
                            {role ? <span data-workstation-role={role} className="rounded-full border border-[var(--border-1)] px-2 py-0.5 text-xs">{role === 'pilot' ? 'Pilot' : 'Drone'}</span> : null}
                            {role === 'drone' ? <span className="basis-full text-xs text-[var(--fg-3)]">{droneRefusal(role)}</span> : null}
                            {remote.tynnWorkstation.registered ? (
                                <>
                                    <span>This machine is registered with <span className="font-mono">{remote.tynnWorkstation.host.replace(/^https?:\/\//, '')}</span> as workstation <span className="font-mono text-xs">{remote.tynnWorkstation.workstationId}</span></span>
                                    {/* Reachable over the Tynn relay (Tynn #838), or why not — Tynn's own words. */}
                                    {remote.tynnWorkstation.relay ? (
                                        <span data-tynn-relay={remote.tynnWorkstation.relay.state} className="basis-full text-xs text-[var(--fg-3)]">
                                            {remote.tynnWorkstation.relay.state === 'reachable' ? `Reachable through the Tynn relay (${remote.tynnWorkstation.relay.relay.replace(/^wss?:\/\//, '')}).`
                                                : remote.tynnWorkstation.relay.state === 'reconnecting' ? <>Reconnecting to the Tynn relay since <time dateTime={new Date(remote.tynnWorkstation.relay.since).toISOString()}>{sinceWords(remote.tynnWorkstation.relay.since, now)}</time>: {remote.tynnWorkstation.relay.reason}.</>
                                                : remote.tynnWorkstation.relay.state === 'unavailable' ? `Not reachable through Tynn: ${remote.tynnWorkstation.relay.reason}`
                                                : remote.tynnWorkstation.relay.state === 'connecting' ? 'Connecting to the Tynn relay…'
                                                : 'Turn on remote access to be reachable through Tynn.'}
                                        </span>
                                    ) : null}
                                </>
                            ) : (
                                <span className="text-[var(--fg-2)]">Not registered: {remote.tynnWorkstation.reason}.</span>
                            )}
                        </div>
                    ) : null}
                    {!remote.enabled ? null : remote.url === null ? (
                        <p className="text-sm text-[var(--fg-3)]">Nothing is listening on {remote.host}, so devices cannot connect yet: {remote.unavailable ?? 'no reason reported'}. The in-app surfaces are unaffected.</p>
                    ) : (
                        // Pair a device: the phone's app first, then the PIN; the address the phone keeps (Tynn #750, #752, #751).
                        <PairGuide remote={{ ...remote, url: remote.url }} pairUrl={pairUrl} now={now} onAction={onAction} button={button} />
                    )}
                    <div className="flex items-center gap-3 text-sm">
                        <Button size="xs" type="button" className={button} onClick={() => onAction({ kind: remote.locked ? 'remote.unlock' : 'remote.lock' })}>{remote.locked ? 'Unlock' : 'Lock'}</Button>
                        <span className="text-xs text-[var(--fg-3)]">{remote.locked ? 'Locked: every remote change is refused until you unlock; reading still works.' : 'Lock refuses every remote change at once.'}</span>
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Paired devices</h3>
                        {remote.devices.length === 0 ? <p className="text-sm text-[var(--fg-3)]">No device has paired with {remote.host}.</p> : (
                            <ul className="divide-y divide-[var(--border-1)]">
                                {remote.devices.map((d) => {
                                    // Close to the end of its 90 days (q_8c07b142): the Settings row's yellow !, here on the device itself,
                                    // with Re-pair. Connecting from the device renews it on its own.
                                    const soon = isExpiringSoon(d.expiresAt, now);
                                    const expiry = deviceExpiryText(d.label, d.expiresAt);
                                    return (
                                        <li key={d.id} data-device={d.id} className="flex items-center gap-3 py-1.5 text-sm">
                                            <span className="font-medium">{d.label}</span>
                                            {soon ? (
                                                <Tooltip content={expiry} placement="top" className="max-w-sm">
                                                    <span data-device-expiry-alert="" role="img" aria-label={expiry} className="px-1 text-[14px] font-bold leading-none text-[var(--warning)]">!</span>
                                                </Tooltip>
                                            ) : null}
                                            <span className="font-mono text-xs text-[var(--fg-4)]">paired {d.pairedAt} · seen {d.lastSeenAt}</span>
                                            {soon ? <Button size="xs" type="button" data-action="repair-device" className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'remote.issuePin', replaces: d.id })}>Re-pair</Button> : null}
                                            <Button size="xs" type="button" className={`${soon ? '' : 'ml-auto '}${button}`} onClick={() => onAction({ kind: 'remote.revokeDevice', deviceId: d.id })}>Revoke</Button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Connected now</h3>
                        {remote.connections.length === 0 ? <p className="text-sm text-[var(--fg-3)]">Nobody is connected.</p> : (
                            <ul className="divide-y divide-[var(--border-1)]">
                                {remote.connections.map((c) => (
                                    <li key={c.id} data-connection={c.id} className="flex items-center gap-3 py-1.5 text-sm">
                                        <span className="font-medium">{c.label}</span>
                                        <Badge variant="soft" size="sm">{c.isOwner ? 'owner' : `shared: ${c.workspaceId === null ? c.workspaceId : workspaceLabel(workspaces, c.workspaceId)}`}</Badge>
                                        {c.driving ? <Badge variant="soft" size="sm">driving</Badge> : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}

/** The box the main-process WebContentsView sits over. Reports its rect on mount and resize; a zero rect on unmount. */
function BrowserBox({ url, onBounds }: { url: string | null; onBounds: (b: { x: number; y: number; width: number; height: number }) => void }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const report = () => { const r = el.getBoundingClientRect(); onBounds({ x: r.x, y: r.y, width: r.width, height: r.height }); };
        report();
        const ro = new ResizeObserver(report);
        ro.observe(el);
        window.addEventListener('resize', report);
        return () => { ro.disconnect(); window.removeEventListener('resize', report); onBounds({ x: 0, y: 0, width: 0, height: 0 }); };
    }, [onBounds]);
    return <div ref={ref} data-browser-view data-browser-url={url ?? undefined} data-route-encoded={browserRoute.format({ ...(url ? { url } : {}) })} className="min-h-0 flex-1" />;
}

const chromeButton = 'shrink-0 rounded-md p-1.5 text-[var(--fg-2)] hover:bg-[var(--bg-1)] disabled:opacity-40 disabled:hover:bg-transparent';

export function BrowserSurface({ data, onAction, onBrowserBounds }: SurfaceProps) {
    const { url, routes, canGoBack, canGoForward, handedOff } = data.browser;
    const nav = url ? classifyNavigation(url, routes) : null;
    return (
        <div data-surface="browser" className="flex h-full min-h-0 flex-col">
            <div data-view-header="" className="flex h-14 shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] px-5">
                <Button size="xs" labelClassName="contents" type="button" data-browser-nav="back" aria-label="Back" title="Back" disabled={!canGoBack} onClick={() => onAction({ kind: 'browser.back' })} className={chromeButton}>
                    <Icon name="chevron-left" size="xs" />
                </Button>
                <Button size="xs" labelClassName="contents" type="button" data-browser-nav="forward" aria-label="Forward" title="Forward" disabled={!canGoForward} onClick={() => onAction({ kind: 'browser.forward' })} className={chromeButton}>
                    <Icon name="chevron-right" size="xs" />
                </Button>
                <Button size="xs" labelClassName="contents" type="button" data-browser-nav="reload" aria-label="Reload" title="Reload" disabled={url === null} onClick={() => onAction({ kind: 'browser.reload' })} className={chromeButton}>
                    <Icon name="rotate-cw" size="xs" />
                </Button>
                {/* Keyed by the url: the field shows the page the view reports (a link, a redirect, back), not a stale entry. */}
                <form
                    key={url ?? ''}
                    className="ml-1.5 flex-1"
                    onSubmit={(e) => { e.preventDefault(); onAction({ kind: 'browser.navigate', url: (new FormData(e.currentTarget).get('url') as string) ?? '' }); }}
                >
                    <Input name="url" type="url" data-browser-address defaultValue={url ?? ''} placeholder="site.gen or localhost:3000" leading={nav?.kind === 'site' ? <Icon name="lock" size="xs" /> : <Icon name="globe" size="xs" />} />
                </form>
                {nav?.kind === 'site' ? <Badge variant="soft" size="sm" color="emerald">{nav.host}</Badge> : null}
                {nav?.kind === 'no-site' ? <Badge variant="soft" size="sm" color="amber">no site at {nav.host}</Badge> : null}
                {nav?.kind === 'refused' ? <Badge variant="soft" size="sm" color="red">{nav.reason}</Badge> : null}
                {/* Dev sites only (Tynn #741): an address off them opened in the person's browser; the pane stayed put. */}
                {handedOff ? <span data-browser-handed-off="" role="status"><Badge variant="soft" size="sm">{handedOff} opened in your browser</Badge></span> : null}
            </div>
            {/* This machine's sites, each opened at its own https origin. */}
            {routes.length > 0 ? (
                <div data-browser-sites className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-1)] px-5 py-1.5">
                    {routes.map((r) => (
                        <Button size="xs"
                            key={r.host}
                            type="button"
                            data-browser-site={r.host}
                            aria-current={nav?.kind === 'site' && nav.host === r.host ? 'page' : undefined}
                            onClick={() => onAction({ kind: 'browser.navigate', url: `https://${r.host}/` })}
                            className={`rounded-md px-2 py-0.5 font-mono text-[12px] hover:bg-[var(--bg-1)] ${nav?.kind === 'site' && nav.host === r.host ? 'bg-[var(--bg-1)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}
                        >
                            {r.host}
                        </Button>
                    ))}
                </div>
            ) : null}
            {/* The page itself is a WebContentsView owned by the main process, positioned over this box. */}
            <BrowserBox url={url} onBounds={onBrowserBounds ?? NO_BOUNDS} />
        </div>
    );
}
