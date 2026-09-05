import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayRoot } from '../../lib/use-overlay-root';
import { IconChevronDown, IconCode, IconPlus } from './icons';
import AgentTerminalForm, { type AgentFormValues } from './AgentTerminalForm';
import {
    api,
    type AgentType,
    type PluginPanelView,
    type TerminalSpec,
    type ViewType,
    type WorkspaceRow,
} from '../../lib/genie';
import {
    TERMINAL_TYPES,
    terminalTypeById,
    agentTerminalTypes,
    panelLauncherTypes,
    type TerminalTypeId,
} from '../../lib/terminal-types';
import { anchoredPopoverTop, clampPopoverAxis } from '../../lib/anchored-popover';
import { addPanelMainButton } from '../../lib/add-panel-button';

/**
 * The split "Add Terminal" button — generalizes the old AddViewButton. The MAIN
 * button repeats the LAST-USED terminal type (`settings.last_terminal_type`,
 * default `regular`); the caret opens the full type registry (Regular / Claude
 * Code / Codex / Custom). Picking a plain terminal creates it straight away;
 * picking a SPECIALIZED type opens an inline AgentInbox form (purpose / scope /
 * command) that calls `terminalSpec.createAgent`. "Add Files…" (an editor) stays a
 * DISTINCT action — in the toolbar it rides in this menu (`includeFiles`), and in
 * the sidebar it keeps its own adjacent button. Closes on outside-click / Escape.
 */
export default function TerminalTypeSplitButton({
    disabled,
    disabledReason,
    workspaceId,
    workspaces,
    lastType,
    onLastTypeChange,
    onAddView,
    pluginPanels = [],
    onAddPluginPanel,
    onAgentCreated,
    customCommand,
    includeFiles,
    variant = 'toolbar',
    agentOnly = false,
    panelLauncher = false,
    allowAgents = true,
    iconOnly = false,
}: {
    disabled: boolean;
    disabledReason?: string;
    /** The workspace new terminals are created into. */
    workspaceId: string | null;
    /** All workspaces (for the `specific`-scope multiselect + slug preview). */
    workspaces: WorkspaceRow[];
    /** Persisted last-used type id (drives the main button). */
    lastType: TerminalTypeId;
    /** Persist a new last-used type. */
    onLastTypeChange: (id: TerminalTypeId) => void;
    /** Create a plain view — 'terminal' (regular) or 'code' (Add Files…). */
    onAddView: (type: ViewType) => void;
    /** Launchable plugin panels (enabled + `ui.panel`-granted) offered in the menu. */
    pluginPanels?: PluginPanelView[];
    /** Open a plugin panel as a `plugin-panel` grid spec. */
    onAddPluginPanel?: (panel: PluginPanelView) => void;
    /** A specialized agent spec was created — select it into view. */
    onAgentCreated: (spec: TerminalSpec) => void;
    /** The configured custom-agent command (placeholder for the command field). */
    customCommand?: string;
    /** Include an "Add Files…" (editor) entry in the dropdown (toolbar only). */
    includeFiles?: boolean;
    variant?: 'toolbar' | 'row';
    /** Dedicated AMS affordance: one obvious New Agent button, no plain shell. */
    agentOnly?: boolean;
    /** One-button workspace launcher for terminals, files, agents and plugins. */
    panelLauncher?: boolean;
    /** System workspace uses Add Panel too, but cannot create project agents. */
    allowAgents?: boolean;
    /**
     * Render the main button as a compact plus icon instead of a labelled pill —
     * the workspace header, where it sits in a row of `.gicon` buttons and a
     * bright accent pill reads as noise. The name moves to `aria-label`/`title`;
     * see `addPanelMainButton`.
     */
    iconOnly?: boolean;
}) {
    // Portal target: NEVER document.body -- Genie's surface tokens live on
    // .gwrap/.genie-overlay-root, and a portal outside that subtree resolves
    // them to nothing and paints transparent (genie #114).
    const overlayRoot = useOverlayRoot();
    const [menuOpen, setMenuOpen] = useState(false);
    const [formAgent, setFormAgent] = useState<AgentType | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    // The dropdown/form popover is portaled to the OVERLAY ROOT (a body child
    // that carries the token scope — never <body> itself) + `position: fixed` (top/
    // left|right set inline from the button's rect below) instead of living
    // inline under `ref`. In the `variant="row"` (Chooser sidebar) usage the
    // button sits inside a scrollable, per-row `isolation: isolate` stacking
    // context — an inline-positioned popover that overflows its own row gets
    // painted UNDER later sibling rows' own content (their text/icons show
    // through it, reading as a transparent panel). Portaling is the same
    // escape hatch Chooser.tsx already uses for AgiHealth / the process-log
    // popover / the process context menu.
    const popRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<
        { top: number; left?: number; right?: number } | null
    >(null);

    const open = menuOpen || formAgent !== null;

    const place = () => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        const box = popRef.current?.getBoundingClientRect();
        const top = anchoredPopoverTop({
            anchorTop: r.top,
            anchorBottom: r.bottom,
            popoverHeight: box?.height ?? 0,
            viewportHeight: window.innerHeight,
        });
        // The `right` form is inside the right edge by construction. The `row`
        // form anchors its LEFT to the button, so a narrow window can push it
        // out -- the other half of the clamp this popover already did
        // vertically (genie#416).
        const next =
            variant === 'row'
                ? {
                      top,
                      left: clampPopoverAxis({
                          start: r.left,
                          size: box?.width ?? 0,
                          viewport: window.innerWidth,
                      }),
                  }
                : { top, right: window.innerWidth - r.right };
        setCoords(
            (current) =>
                current &&
                current.top === next.top &&
                current.left === next.left &&
                current.right === next.right
                    ? current
                    : next,
        );
    };
    // useLayoutEffect: coords are set BEFORE paint so the popover never flashes
    // at (0,0) for a frame.
    useLayoutEffect(() => {
        if (!open) {
            setCoords(null);
            return;
        }
        place();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // The first pass establishes portal coordinates. Once the portal has
    // mounted, measure its real height and flip it above the button if opening
    // below would cross the viewport's bottom edge.
    useLayoutEffect(() => {
        if (open && coords && popRef.current) place();
    });

    useEffect(() => {
        if (!open) return;
        const onAway = (e: MouseEvent) => {
            const t = e.target as Node;
            if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
            setMenuOpen(false);
            setFormAgent(null);
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setMenuOpen(false);
                setFormAgent(null);
            }
        };
        // A portaled popover can't track its anchor's position, so an ANCESTOR
        // scroll (the sidebar list, most likely) or a resize closes it — matching
        // AgiHealth's popover in Chooser.tsx.
        //
        // But this listener is CAPTURE-phase on window, so it also sees scrolls
        // that happen INSIDE the popover — e.g. scrolling the "who can reach this
        // agent" workspace list in the agent form. Those don't move the anchor, so
        // dismissing on them made the form impossible to fill in: it vanished the
        // moment you scrolled that list. Ignore any scroll originating within the
        // popover (or the anchor) and only dismiss on a genuine outside scroll.
        const onScroll = (e: Event) => {
            const t = e.target as Node | null;
            if (t && (popRef.current?.contains(t) || ref.current?.contains(t))) return;
            setMenuOpen(false);
            setFormAgent(null);
        };
        const onResize = () => {
            setMenuOpen(false);
            setFormAgent(null);
        };
        document.addEventListener('mousedown', onAway);
        document.addEventListener('keydown', onEsc);
        window.addEventListener('resize', onResize);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            document.removeEventListener('mousedown', onAway);
            document.removeEventListener('keydown', onEsc);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [open]);

    const lastDef = terminalTypeById(lastType);

    /** Act on a picked terminal type: plain → create now, specialized → open form. */
    const pickType = (id: TerminalTypeId) => {
        setMenuOpen(false);
        const def = terminalTypeById(id);
        if (def.specialized && def.agent) {
            setError(null);
            setFormAgent(def.agent);
        } else {
            onAddView('terminal');
            onLastTypeChange('regular');
        }
    };

    const addFiles = () => {
        setMenuOpen(false);
        onAddView('code');
    };

    const pickPanel = (panel: PluginPanelView) => {
        setMenuOpen(false);
        onAddPluginPanel?.(panel);
    };

    const submitForm = async (agent: AgentType, values: AgentFormValues) => {
        setBusy(true);
        setError(null);
        try {
            const res = await api().terminalSpec.createAgent({
                workspace_id: workspaceId,
                agent,
                // custom REQUIRES a command; for claude/codex an explicit command
                // overrides the server-resolved default when the user typed one.
                command: values.command || undefined,
                purpose: values.purpose,
                scope: values.scope,
                scope_workspaces:
                    values.scope === 'specific' ? values.scopeWorkspaces : undefined,
                issuewatch_handle: values.issuewatchHandle,
            });
            if (res.ok && res.spec) {
                onAgentCreated(res.spec);
                onLastTypeChange(agent);
                setFormAgent(null);
            } else {
                setError(res.error || 'Could not create the agent terminal.');
            }
        } catch {
            setError('Could not create the agent terminal.');
        } finally {
            setBusy(false);
        }
    };

    const LastIcon = lastDef.icon;
    const choices = agentOnly
        ? agentTerminalTypes()
        : panelLauncher
            ? panelLauncherTypes().filter((type) => allowAgents || !type.specialized)
            : TERMINAL_TYPES;
    const menuOnly = agentOnly || panelLauncher;
    const mainBtn = addPanelMainButton({
        panelLauncher,
        agentOnly,
        lastTypeLabel: lastDef.label,
        iconOnly,
        disabled,
        disabledReason,
    });
    const openMain = () => (menuOnly ? setMenuOpen((o) => !o) : pickType(lastDef.id));

    return (
        <div
            className={`addview-split${variant === 'row' ? ' addview-row' : ''}`}
            ref={ref}
            title={disabled ? disabledReason : undefined}
        >
            {mainBtn.iconOnly ? (
                <button
                    type="button"
                    className="gicon"
                    onClick={openMain}
                    disabled={disabled}
                    title={mainBtn.title}
                    aria-label={mainBtn.accessibleName}
                    aria-haspopup={menuOnly ? 'menu' : undefined}
                    aria-expanded={menuOnly ? menuOpen : undefined}
                >
                    <IconPlus size={16} />
                </button>
            ) : (
                <button
                    type="button"
                    className="gbtn accent addview-main"
                    onClick={openMain}
                    disabled={disabled}
                    title={mainBtn.title}
                >
                    {menuOnly ? <IconCode size={14} /> : <LastIcon size={14} />}
                    {mainBtn.label}
                </button>
            )}
            {!menuOnly && <button
                type="button"
                className="gbtn accent addview-caret"
                onClick={() => {
                    setFormAgent(null);
                    setMenuOpen((o) => !o);
                }}
                disabled={disabled}
                title="Choose a terminal type"
                aria-label="Choose a terminal type"
            >
                <IconChevronDown size={13} />
            </button>}

            {menuOpen &&
                coords &&
                overlayRoot &&
                createPortal(
                    <div
                        ref={popRef}
                        className="addview-menu addview-type-menu"
                        role="menu"
                        style={{ top: coords.top, left: coords.left, right: coords.right }}
                    >
                        {choices.map((t) => {
                            const Ico = t.icon;
                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    role="menuitem"
                                    className="addview-type-item"
                                    onClick={() => pickType(t.id)}
                                >
                                    <Ico size={14} />
                                    <span className="addview-type-main">
                                        <span className="addview-type-label">{t.label}</span>
                                        {t.hint && (
                                            <span className="addview-type-hint">{t.hint}</span>
                                        )}
                                    </span>
                                </button>
                            );
                        })}
                        {includeFiles && (
                            <>
                                <div className="addview-menu-divider" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="addview-type-item"
                                    onClick={addFiles}
                                >
                                    <IconCode size={14} />
                                    <span className="addview-type-main">
                                        <span className="addview-type-label">Add Files…</span>
                                        <span className="addview-type-hint">
                                            Open a file editor
                                        </span>
                                    </span>
                                </button>
                            </>
                        )}
                        {onAddPluginPanel && pluginPanels.length > 0 && (
                            <>
                                <div className="addview-menu-divider" />
                                {pluginPanels.map((p) => (
                                    <button
                                        key={p.launchId}
                                        type="button"
                                        role="menuitem"
                                        className="addview-type-item"
                                        onClick={() => pickPanel(p)}
                                    >
                                        <IconCode size={14} />
                                        <span className="addview-type-main">
                                            <span className="addview-type-label">
                                                {p.panel.title}
                                            </span>
                                            <span className="addview-type-hint">
                                                {p.pluginName} panel
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </>
                        )}
                    </div>,
                    overlayRoot,
                )}

            {formAgent &&
                coords &&
                overlayRoot &&
                createPortal(
                    <div
                        ref={popRef}
                        className="addview-menu addview-form-pop"
                        role="dialog"
                        aria-label={`New ${terminalTypeById(formAgent).label}`}
                        style={{ top: coords.top, left: coords.left, right: coords.right }}
                    >
                        <div className="addview-form-title">
                            New {terminalTypeById(formAgent).label}
                        </div>
                        <AgentTerminalForm
                            agent={formAgent}
                            workspaces={workspaces}
                            ownWorkspaceId={workspaceId}
                            submitLabel="Create"
                            busy={busy}
                            error={error}
                            customPlaceholder={customCommand}
                            onSubmit={(v) => void submitForm(formAgent, v)}
                            onCancel={() => setFormAgent(null)}
                        />
                    </div>,
                    overlayRoot,
                )}
        </div>
    );
}
