import { useEffect, useState } from 'react';
import {
    Action,
    Badge,
    Callout,
    Card,
    CodeView,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Switch,
    Tabs,
    Text,
    Textarea,
} from '@particle-academy/react-fancy';
import {
    api,
    detectedShells,
    isSystemWorkspace,
    ulid,
    type ShellDetection,
    type TerminalSpec,
    type WorkspaceRow,
} from '../../lib/genie';
import {
    draftFromSpec,
    draftProblems,
    draftToCreate,
    draftToPatch,
    emptyProcessDraft,
    processCard,
    restartAfterSave,
    splitProcessTabs,
    type ProcessAction,
    type ProcessCardView,
    type ProcessCreate,
    type ProcessDraft,
    type ProcessPatch,
    type ProcessTone,
} from '../../lib/process-manager';
import { SCHEDULE_PRESETS } from '../../lib/schedule-view';
import { useProcessRuntime } from '../../lib/use-process-runtime';
import { pickPath } from '../FilePickerModal';

/**
 * THE PROCESSES MODAL — a workspace's background processes, built like the Site
 * Manager (owner).
 *
 * These used to live in an expanding block in the sidebar: a row per process with
 * icon-only buttons, the output on HOVER, Edit behind a right-click, and a form that
 * could set only five of a process's properties. Here every process is a card that
 * says what it runs, where, with what, how it behaves and what state it is in, with
 * its controls named in words; its output is a panel you open and can keep open;
 * and the form sets everything a process has — including its environment and
 * whether it starts with Genie or restarts when it exits, which had no UI at all.
 *
 * Every judgement is in `lib/process-manager.ts` (tested — the renderer has no DOM
 * harness); this file is wiring. Creating and saving go through the handlers in
 * `master.tsx`, which keep the window's spec list in step.
 */

type Tab = 'services' | 'scheduled';

/** How often an OPEN output panel re-reads the tail. Process output has no push
 *  channel; this is the cadence the sidebar's hover log already used, and it runs
 *  only while a panel is open. */
const LOG_REFRESH_MS = 1_000;
const LOG_TAIL_LINES = 500;

const tail = (text: string, lines: number) => {
    const all = text.split('\n');
    return all.length > lines ? all.slice(-lines).join('\n') : text;
};

/** Dot + status-line colour, in the Site Manager's own vocabulary where one exists. */
const TONE_CLASS: Record<ProcessTone, string> = {
    running: 'site-running',
    starting: 'site-starting',
    crashed: 'site-failed',
    stopped: '',
    armed: 'proc-armed',
    disarmed: '',
    awaiting: 'proc-awaiting',
};

export default function WorkspaceProcessManager({
    workspace,
    specs,
    onCreate,
    onUpdate,
    onSetEnabled,
    onDelete,
    onClose,
}: {
    workspace: WorkspaceRow;
    /** This workspace's processes (`processSpecsOf`). */
    specs: TerminalSpec[];
    onCreate: (spec: ProcessCreate & { id: string }) => Promise<void>;
    onUpdate: (id: string, patch: ProcessPatch, restart: boolean) => Promise<void>;
    /** Arm or pause a scheduled task without deleting it. Through the window's own
     *  handler, because main does not broadcast a renderer's own spec edits back. */
    onSetEnabled: (id: string, enabled: boolean) => Promise<boolean>;
    onDelete: (id: string) => void;
    onClose: () => void;
}) {
    const { processStatus, scheduleInfo } = useProcessRuntime();
    const { services, scheduled } = splitProcessTabs(specs);
    // Open on the tab that has something in it.
    const [tab, setTab] = useState<Tab>(() => (services.length === 0 && scheduled.length > 0 ? 'scheduled' : 'services'));
    const [form, setForm] = useState<{ spec: TerminalSpec | null } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [log, setLog] = useState<{ id: string; text: string } | null>(null);
    /** The process whose delete is being confirmed. */
    const [deleting, setDeleting] = useState<TerminalSpec | null>(null);
    const [now, setNow] = useState(() => Date.now());

    // "in 2 hr" / "Ran 5 min ago" are relative: refresh them once a minute rather
    // than let an open modal drift into saying something false.
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(t);
    }, []);

    const openLogId = log?.id ?? null;
    useEffect(() => {
        if (!openLogId) return;
        let alive = true;
        const read = () =>
            void api()
                .process.log(openLogId)
                .then((text) => {
                    if (alive) setLog((cur) => (cur && cur.id === openLogId ? { id: openLogId, text: tail(text, LOG_TAIL_LINES) } : cur));
                })
                .catch(() => {});
        read();
        const t = setInterval(read, LOG_REFRESH_MS);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, [openLogId]);

    const run = async (spec: TerminalSpec, action: ProcessAction) => {
        if (action === 'logs') {
            setLog((cur) => (cur?.id === spec.id ? null : { id: spec.id, text: '' }));
            return;
        }
        if (action === 'edit') {
            setForm({ spec });
            return;
        }
        if (action === 'delete') {
            // A Fancy Modal, not the app-level `showPrompt`: that prompt's layer
            // sits BELOW Fancy's overlay by design (overlay-layers.test.ts), so
            // opened from inside this modal it rendered behind it, unclickable.
            setDeleting(spec);
            return;
        }
        setBusy(spec.id);
        setError(null);
        try {
            const p = api();
            const res =
                action === 'start'
                    ? await p.process.start(spec.id)
                    : action === 'stop'
                      ? await p.process.stop(spec.id)
                      : action === 'restart'
                        ? await p.process.restart(spec.id)
                        : action === 'run-now'
                          ? await p.schedule.runNow(spec.id)
                          : // Arm / pause WITHOUT deleting: main re-arms or disarms off the
                            // spec's `enabled` flag, so flipping it is the whole operation.
                            { ok: await onSetEnabled(spec.id, action === 'arm') };
            if (!res.ok) setError(`Genie could not ${ACTION_VERB[action]} “${spec.label}”.`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    const runningServices = services.filter((s) => processStatus.get(s.id) === 'running').length;

    return (
        <Modal open onClose={onClose} size="xl">
            <Modal.Header>
                <Heading as="h2" size="sm">
                    Processes — {workspace.project_name}
                </Heading>
            </Modal.Header>
            <div className="ws-settings site-manager process-manager">
                <div className="ws-settings-head">
                    <Text size="xs" className="text-zinc-500">
                        Commands Genie keeps running for this workspace, or runs on a schedule — with no
                        terminal open, and whether or not an agent is here.
                    </Text>
                </div>
                {error && <div className="set-note bad">{error}</div>}

                <Tabs activeTab={tab} onTabChange={(t) => setTab(t as Tab)}>
                    <Tabs.List>
                        <Tabs.Tab value="services">
                            Services{services.length ? ` (${runningServices}/${services.length})` : ''}
                        </Tabs.Tab>
                        <Tabs.Tab value="scheduled">Scheduled{scheduled.length ? ` (${scheduled.length})` : ''}</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panels>
                        <Tabs.Panel value="services">
                            <ProcessList
                                title="Services"
                                description="Long-running commands — a queue worker, a websocket server, a watcher."
                                empty="No services yet. Add one and Genie keeps it running for this workspace."
                                specs={services}
                                workspace={workspace}
                                processStatus={processStatus}
                                scheduleInfo={scheduleInfo}
                                now={now}
                                busy={busy}
                                log={log}
                                onAction={run}
                                onAdd={() => setForm({ spec: null })}
                            />
                        </Tabs.Panel>
                        <Tabs.Panel value="scheduled">
                            <ProcessList
                                title="Scheduled"
                                description="Commands that run on a schedule, in this machine’s local time."
                                empty="Nothing scheduled. Add a process and give it a schedule."
                                specs={scheduled}
                                workspace={workspace}
                                processStatus={processStatus}
                                scheduleInfo={scheduleInfo}
                                now={now}
                                busy={busy}
                                log={log}
                                onAction={run}
                                onAdd={() => setForm({ spec: null })}
                            />
                        </Tabs.Panel>
                    </Tabs.Panels>
                </Tabs>
            </div>

            {deleting && (
                <Modal open onClose={() => setDeleting(null)} size="sm">
                    <Modal.Header>
                        <Heading as="h3" size="xs">
                            Delete process
                        </Heading>
                    </Modal.Header>
                    <div className="ws-settings process-delete-confirm">
                        <Text size="sm">
                            Delete “{deleting.label}”? It is stopped and removed from this workspace. Its
                            files are untouched.
                        </Text>
                        <div className="set-actions">
                            <Action
                                size="sm"
                                color="red"
                                icon="trash-2"
                                onClick={() => {
                                    onDelete(deleting.id);
                                    if (log?.id === deleting.id) setLog(null);
                                    setDeleting(null);
                                }}
                            >
                                Delete process
                            </Action>
                            <Action size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                                Cancel
                            </Action>
                        </div>
                    </div>
                </Modal>
            )}

            {form && (
                <ProcessForm
                    workspace={workspace}
                    spec={form.spec}
                    initialSchedule={!form.spec && tab === 'scheduled'}
                    onCancel={() => setForm(null)}
                    onSubmit={async (draft) => {
                        if (form.spec) {
                            const patch = draftToPatch(draft, form.spec, workspace);
                            await onUpdate(form.spec.id, patch, restartAfterSave(form.spec, patch, processStatus.get(form.spec.id)));
                        } else {
                            await onCreate({ id: ulid(), ...draftToCreate(draft, workspace) });
                        }
                        setForm(null);
                    }}
                />
            )}
        </Modal>
    );
}

const ACTION_VERB: Record<ProcessAction, string> = {
    start: 'start',
    stop: 'stop',
    restart: 'restart',
    'run-now': 'run',
    arm: 'enable',
    disarm: 'pause',
    logs: 'show the output of',
    edit: 'edit',
    delete: 'delete',
};

function ProcessList({
    title,
    description,
    empty,
    specs,
    workspace,
    processStatus,
    scheduleInfo,
    now,
    busy,
    log,
    onAction,
    onAdd,
}: {
    title: string;
    description: string;
    empty: string;
    specs: TerminalSpec[];
    workspace: WorkspaceRow;
    processStatus: ReturnType<typeof useProcessRuntime>['processStatus'];
    scheduleInfo: ReturnType<typeof useProcessRuntime>['scheduleInfo'];
    now: number;
    busy: string | null;
    log: { id: string; text: string } | null;
    onAction: (spec: TerminalSpec, action: ProcessAction) => void;
    onAdd: () => void;
}) {
    return (
        <section className="set-section">
            <div className="set-section-head">
                <h2>{title}</h2>
                <span className="set-section-desc">{description}</span>
            </div>
            {specs.length === 0 ? (
                <div className="set-note">{empty}</div>
            ) : (
                <div className="site-list">
                    {specs.map((spec) => (
                        <ProcessCard
                            key={spec.id}
                            card={processCard(spec, workspace, processStatus.get(spec.id), scheduleInfo.get(spec.id), now)}
                            busy={busy === spec.id}
                            log={log?.id === spec.id ? log.text : null}
                            onAction={(action) => onAction(spec, action)}
                        />
                    ))}
                </div>
            )}
            <div className="set-actions">
                <Action size="sm" variant="ghost" icon="plus" onClick={onAdd}>
                    Add a process…
                </Action>
            </div>
        </section>
    );
}

/** What each action button says, and its icon. */
const ACTION_BUTTON: Record<ProcessAction, { label: string; icon: string }> = {
    start: { label: 'Start', icon: 'play' },
    stop: { label: 'Stop', icon: 'square' },
    restart: { label: 'Restart', icon: 'rotate-cw' },
    'run-now': { label: 'Run now', icon: 'play' },
    arm: { label: 'Enable schedule', icon: 'clock' },
    disarm: { label: 'Pause schedule', icon: 'pause' },
    logs: { label: 'Output', icon: 'file-text' },
    edit: { label: 'Edit', icon: 'pencil' },
    delete: { label: 'Delete', icon: 'trash-2' },
};

function ProcessCard({
    card,
    busy,
    log,
    onAction,
}: {
    card: ProcessCardView;
    busy: boolean;
    log: string | null;
    onAction: (action: ProcessAction) => void;
}) {
    const tone = TONE_CLASS[card.tone];
    const nudge = card.schedule?.kind === 'agent-nudge';

    return (
        <Card variant="outlined" padding="md" className="site-card process-card" data-process-id={card.id}>
            <div className="site-card-head">
                <span className={`site-dot ${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {card.label}{' '}
                        <Badge size="sm" variant="soft" color="zinc">
                            {card.kind === 'scheduled' ? 'scheduled' : 'service'}
                        </Badge>
                    </Text>
                    <Text size="xs" className="text-zinc-500">
                        {card.runsIn} · {card.shell}
                    </Text>
                </div>
            </div>

            <div className={`site-card-status ${tone}`}>{card.statusLabel}</div>

            {card.schedule?.pendingApproval && (
                <Callout color="amber" icon={<Icon name="info" size="sm" />}>
                    An agent scheduled this. It does not fire until it is approved.
                </Callout>
            )}

            <div className="site-card-fields">
                {!nudge && (
                    <label className="site-field site-field-wide">
                        <span>Command</span>
                        <Input value={card.command} readOnly disabled />
                    </label>
                )}
                {card.schedule && (
                    <>
                        <label className="site-field">
                            <span>Schedule</span>
                            <Input value={card.schedule.description} readOnly disabled />
                        </label>
                        <label className="site-field">
                            <span>Next run</span>
                            <Input value={card.schedule.next} readOnly disabled />
                        </label>
                        <label className="site-field site-field-wide">
                            <span>Last run</span>
                            <Text size="xs" className="process-last-run">
                                <span className={`sched-dot sched-dot-${card.schedule.lastTone}`} aria-hidden="true" />{' '}
                                {card.schedule.last}
                            </Text>
                        </label>
                        {nudge && (
                            <label className="site-field site-field-wide">
                                <span>Each run nudges an agent with</span>
                                <Textarea value={card.schedule.nudgePrompt ?? ''} readOnly disabled rows={2} />
                            </label>
                        )}
                    </>
                )}
                {card.behaviours.length > 0 && (
                    <div className="site-field site-field-wide">
                        <span>Behaviour</span>
                        <div className="process-behaviours">
                            {card.behaviours.map((b) => (
                                <Badge key={b} size="sm" variant="soft" color="zinc">
                                    {b}
                                </Badge>
                            ))}
                        </div>
                    </div>
                )}
                {card.env.length > 0 && (
                    <div className="svc-env site-field-wide">
                        <span className="svc-env-label">Environment</span>
                        <CodeView value={card.env.map(([k, v]) => `${k}=${v}`).join('\n')} readOnly minHeight={0} maxHeight={140} />
                    </div>
                )}
            </div>

            {log !== null && <OutputPanel id={card.id} label={card.label} text={log} />}

            <div className="set-actions">
                {card.actions.map((action) => (
                    <Action
                        key={action}
                        size="sm"
                        variant={action === 'start' || action === 'run-now' ? undefined : 'ghost'}
                        color={action === 'start' || action === 'run-now' ? 'blue' : undefined}
                        icon={ACTION_BUTTON[action].icon}
                        disabled={busy && action !== 'logs'}
                        onClick={() => onAction(action)}
                    >
                        {action === 'logs' && log !== null
                            ? 'Hide output'
                            : action === 'start' && card.tone === 'crashed'
                              ? 'Start again'
                              : ACTION_BUTTON[action].label}
                    </Action>
                ))}
            </div>
        </Card>
    );
}

/** A process's recent output, kept live while open, with the three things people
 *  do with a log: copy the end of it, save all of it, or clear it. */
function OutputPanel({ id, label, text }: { id: string; label: string; text: string }) {
    const download = () => {
        void api()
            .process.log(id)
            .then((full) => {
                const url = URL.createObjectURL(new Blob([full], { type: 'text/plain' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = `${(label || 'process').replace(/[^\w.-]+/g, '_')}.log`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            })
            .catch(() => {});
    };
    return (
        <div className="svc-env process-output">
            <span className="svc-env-label">Output — the last {LOG_TAIL_LINES} lines, live</span>
            <CodeView value={text || 'Nothing output yet.'} readOnly minHeight={0} maxHeight={260} />
            <div className="set-actions">
                <Action
                    size="sm"
                    variant="ghost"
                    icon="copy"
                    onClick={() => void navigator.clipboard.writeText(tail(text, 100)).catch(() => {})}
                >
                    Copy last 100 lines
                </Action>
                <Action size="sm" variant="ghost" icon="download" onClick={download}>
                    Save full output…
                </Action>
                <Action size="sm" variant="ghost" icon="eraser" onClick={() => void api().process.clearLog(id).catch(() => {})}>
                    Clear
                </Action>
            </div>
        </div>
    );
}

function ProcessForm({
    workspace,
    spec,
    initialSchedule,
    onCancel,
    onSubmit,
}: {
    workspace: WorkspaceRow;
    spec: TerminalSpec | null;
    /** Opened from the Scheduled tab: start with a schedule chosen. */
    initialSchedule: boolean;
    onCancel: () => void;
    onSubmit: (draft: ProcessDraft) => Promise<void>;
}) {
    const system = isSystemWorkspace(workspace);
    const [draft, setDraft] = useState<ProcessDraft>(() => {
        if (spec) return draftFromSpec(spec, workspace);
        const empty = emptyProcessDraft(workspace);
        return initialSchedule ? { ...empty, schedulePreset: '0 3 * * *', schedule: '0 3 * * *' } : empty;
    });
    const [repos, setRepos] = useState<string[]>([]);
    const [shells, setShells] = useState<ShellDetection[]>([]);
    const [attempted, setAttempted] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!system) {
            void api()
                .workspaces.repos(workspace.id)
                .then(setRepos)
                .catch(() => setRepos([]));
        }
        void detectedShells()
            .then(({ shells: found }) => setShells(found))
            .catch(() => setShells([]));
    }, [workspace.id, system]);

    const set = <K extends keyof ProcessDraft>(key: K, value: ProcessDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
    const problems = draftProblems(draft, workspace);
    const scheduled = draft.schedule.trim() !== '';

    const submit = async () => {
        setAttempted(true);
        if (problems.length > 0) return;
        setSaving(true);
        setError(null);
        try {
            await onSubmit(draft);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    const shellList = [
        { value: '', label: 'Default shell' },
        ...shells.map((s) => ({ value: s.command, label: s.label })),
        // An edited process can name a shell this machine did not detect — keep it
        // selectable rather than silently switching it to the default on save.
        ...(draft.shell && !shells.some((s) => s.command === draft.shell) ? [{ value: draft.shell, label: draft.shell }] : []),
    ];

    return (
        <Modal open onClose={onCancel} size="lg">
            <Modal.Header>
                <Heading as="h3" size="xs">
                    {spec ? `Edit ${spec.label}` : 'Add a process'}
                </Heading>
            </Modal.Header>
            <div className="ws-settings site-manager process-form">
                {error && <div className="set-note bad">{error}</div>}
                <div className="site-card-fields">
                    <label className="site-field site-field-wide">
                        <span>Command</span>
                        <Input
                            value={draft.command}
                            onValueChange={(v: string) => set('command', v)}
                            placeholder="php artisan queue:work"
                            autoFocus
                        />
                    </label>
                    <label className="site-field">
                        <span>Name (optional)</span>
                        <Input value={draft.label} onValueChange={(v: string) => set('label', v)} placeholder="Queue worker" />
                    </label>
                    <label className="site-field">
                        <span>Runs in</span>
                        {system ? (
                            <div className="site-docroot">
                                <Input value={draft.dir} readOnly disabled placeholder="Choose a directory" />
                                <Action
                                    size="sm"
                                    variant="ghost"
                                    icon="folder-open"
                                    onClick={() =>
                                        void pickPath({
                                            mode: 'directory',
                                            title: 'Choose a directory for this process',
                                            initialPath: draft.dir || workspace.path,
                                        })
                                            .then((dir) => {
                                                if (dir) set('dir', dir);
                                            })
                                            .catch(() => {})
                                    }
                                >
                                    Choose…
                                </Action>
                            </div>
                        ) : (
                            <Select
                                value={draft.repo}
                                onValueChange={(v: string) => set('repo', v)}
                                list={[
                                    { value: '', label: 'The workspace root' },
                                    ...repos.map((r) => ({ value: r, label: `repos/${r}` })),
                                    ...(draft.repo && !repos.includes(draft.repo) ? [{ value: draft.repo, label: `repos/${draft.repo}` }] : []),
                                ]}
                            />
                        )}
                    </label>
                    <label className="site-field">
                        <span>Shell</span>
                        <Select value={draft.shell} onValueChange={(v: string) => set('shell', v)} list={shellList} />
                    </label>
                    <label className="site-field">
                        <span>Schedule</span>
                        <Select
                            value={draft.schedulePreset}
                            onValueChange={(v: string) =>
                                // A preset IS the expression; 'custom' hands the field to
                                // the user; '' clears the schedule (back to a service).
                                setDraft((d) => ({ ...d, schedulePreset: v, schedule: v === 'custom' ? d.schedule : v }))
                            }
                            list={[...SCHEDULE_PRESETS]}
                        />
                    </label>
                    {draft.schedulePreset === 'custom' && (
                        <label className="site-field site-field-wide">
                            <span>Schedule expression</span>
                            <Input
                                value={draft.schedule}
                                onValueChange={(v: string) => set('schedule', v)}
                                placeholder="0 3 * * *"
                            />
                            <small className="site-field-hint">
                                Five fields — minute, hour, day of month, month, day of week — in this machine’s
                                local time.
                            </small>
                        </label>
                    )}
                    <label className="site-field site-field-wide">
                        <span>Starts with Genie</span>
                        <Switch
                            checked={!scheduled && draft.autostart}
                            disabled={scheduled}
                            onCheckedChange={(on: boolean) => set('autostart', on)}
                        />
                        <small className="site-field-hint">
                            {scheduled
                                ? 'A scheduled process runs when its schedule says, not when Genie starts.'
                                : 'Start it whenever Genie opens, without anyone pressing Start.'}
                        </small>
                    </label>
                    <label className="site-field site-field-wide">
                        <span>Restarts if it exits</span>
                        <Switch
                            checked={!scheduled && draft.restartOnExit}
                            disabled={scheduled}
                            onCheckedChange={(on: boolean) => set('restartOnExit', on)}
                        />
                        <small className="site-field-hint">
                            {scheduled
                                ? 'Each scheduled run is one-shot: it runs, finishes, and waits for the next time.'
                                : 'Bring it back, with a growing delay, when it stops or crashes on its own.'}
                        </small>
                    </label>
                    <label className="site-field site-field-wide">
                        <span>Environment — NAME=value, one per line</span>
                        <Textarea
                            value={draft.envText}
                            onValueChange={(v: string) => set('envText', v)}
                            rows={3}
                            spellCheck={false}
                            placeholder={'APP_ENV=local\nQUEUE_CONNECTION=redis'}
                        />
                    </label>
                </div>

                {spec && (
                    <Text size="xs" className="text-zinc-500">
                        A running service restarts when its command, directory, shell or environment changes, so
                        the change takes effect. Renaming it does not interrupt it.
                    </Text>
                )}

                {attempted && problems.length > 0 && (
                    <div className="set-note bad" role="alert">
                        {problems.map((p) => (
                            <div key={p}>{p}</div>
                        ))}
                    </div>
                )}

                <div className="set-actions">
                    <Action size="sm" color="blue" icon="check" disabled={saving} onClick={() => void submit()}>
                        {saving ? 'Saving…' : spec ? 'Save changes' : 'Add process'}
                    </Action>
                    <Action size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
                        Cancel
                    </Action>
                </div>
            </div>
        </Modal>
    );
}
