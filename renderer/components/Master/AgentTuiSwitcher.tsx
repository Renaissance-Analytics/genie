import { useState } from 'react';
import { Popover } from '@particle-academy/react-fancy';
import { api } from '../../lib/genie';
import type { AgentRuntimeSpec } from '../../lib/ams-grid';
import { driverRows } from '../../lib/agent-manager';
import { providerBrandMark } from '../../lib/provider-brand';
import { agentTerminalTypes } from '../../lib/terminal-types';
import { BrandMark } from './BrandMark';

/**
 * Switch the TUI an agent runs under, and see its sidecars — from the panel's
 * own controls, where the agent actually is.
 *
 * An agent is not its TUI: claude, codex, kiwi and the Genie TUI are drivers it
 * moves between. The one it moves AWAY from keeps its pty and its conversation
 * as a hidden sidecar to flip straight back to, which is what makes switching
 * safe at all — a Claude transcript means nothing to Codex, so continuity is
 * per-TUI and the sidecar is where each thread waits.
 *
 * NOTHING here stops a TUI. Adding a driver and fronting it are the only two
 * actions; a running sidecar is listed, never killed. Stopping one costs a live
 * process and a conversation, so it stays an explicit, confirmed act elsewhere —
 * the manager's Driver tab, which is this control's full-size counterpart.
 *
 * The rows come from `driverRows`, which is `decideTuiSwitch` — the rule the host
 * applies to `runAgent switchTui` and to `agentRecordAddRuntime`. So this menu
 * cannot offer a driver the agent's own `AGENT.md` excludes (genie#463); it shows
 * the host's reason instead of a button that could only ever be refused.
 */
export default function AgentTuiSwitcher({
    agentId,
    runtimes,
    allowed,
    current,
    onChanged,
    avatar,
}: {
    agentId: string;
    runtimes: AgentRuntimeSpec[];
    /** `tuis:` from the agent's AGENT.md. EMPTY is "no opinion", not "none". */
    allowed?: string[];
    /** The agent's recorded driver, for a panel whose agent has no fronted
     *  runtime yet. Absent here means "whatever the runtimes say". */
    current?: string | null;
    /** The agent's current mark, so the field opens showing what is set. */
    avatar?: string | null;
    onChanged: () => void;
}) {
    const [mark, setMark] = useState(avatar ?? '');
    const [markError, setMarkError] = useState<string | null>(null);
    const [switchError, setSwitchError] = useState<string | null>(null);
    const mine = runtimes.filter((r) => r.agentId === agentId);
    const fronted = mine.find((r) => r.fronted);
    const sidecars = mine.filter((r) => !r.fronted);

    const rows = driverRows({
        drivers: agentTerminalTypes().map((type) => ({
            tui: String(type.agent),
            label: type.label,
        })),
        runtimes: mine,
        allowed: allowed ?? [],
        current: current ?? null,
    });

    const pick = (provider: string): void => {
        setSwitchError(null);
        void api()
            .agents.addRuntime(agentId, provider)
            .then((r) => {
                // A refusal is REPORTED. The host can turn a switch down for a
                // reason this menu could not know at render time — an AGENT.md
                // edited since it opened — and a click that silently does
                // nothing reads as a broken control.
                if (r.ok) onChanged();
                else setSwitchError(r.error ?? 'That driver was refused.');
            })
            .catch(() => setSwitchError('That driver was refused.'));
    };

    // The agent's OWN mark, overriding the TUI brand icon everywhere it is
    // drawn. It belongs beside the driver control because both answer "what is
    // this agent" -- and because the brand mark it replaces is the thing the
    // driver control changes.
    const saveMark = (next: string): void => {
        setMark(next);
        setMarkError(null);
        void api()
            .agents.setAvatar(agentId, next)
            .then((r) => {
                // Main REJECTS more than one glyph rather than truncating, so
                // the reason is shown; a silently dropped avatar reads as a
                // dead field.
                if (!r.ok) setMarkError(r.error ?? 'Could not save that avatar.');
                else onChanged();
            })
            .catch(() => setMarkError('Could not save that avatar.'));
    };

    return (
        <Popover placement="bottom-end" offset={6}>
            <Popover.Trigger aria-label="Switch TUI">
                <span
                    className="pctl agent-tui-trigger"
                    title={
                        fronted
                            ? `Running ${fronted.tui}${
                                  sidecars.length > 0 ? ` · ${sidecars.length} sidecar(s)` : ''
                              }`
                            : 'No TUI yet'
                    }
                    onClick={(e) => e.stopPropagation()}
                >
                    {fronted ? <Mark provider={fronted.tui} /> : <span>·</span>}
                    {sidecars.length > 0 && (
                        <span className="agent-tui-count">{sidecars.length}</span>
                    )}
                </span>
            </Popover.Trigger>
            <Popover.Content className="agent-tui-menu" role="menu">
                <TuiSwitcherMenu
                    rows={rows}
                    mark={mark}
                    markError={markError}
                    switchError={switchError}
                    onPick={pick}
                    onMark={saveMark}
                />
            </Popover.Content>
        </Popover>
    );
}

/**
 * The menu's BODY — presentational, and exported so it can be rendered in a
 * test.
 *
 * `Popover.Content` renders nothing on the server (the popover is closed), so a
 * test of the component above can only ever see the trigger. Split for the same
 * reason `AgentRosterList` is: the renderer has no DOM harness, and a refusal
 * nobody can assert on is a refusal nobody knows is there.
 */
export function TuiSwitcherMenu({
    rows,
    mark,
    markError,
    switchError,
    onPick,
    onMark,
}: {
    rows: ReturnType<typeof driverRows>;
    mark: string;
    markError: string | null;
    /** A switch the host turned down after this menu was drawn. */
    switchError: string | null;
    onPick: (tui: string) => void;
    onMark: (next: string) => void;
}) {
    return (
        <>
            <div className="agent-tui-head">Driver</div>
            {rows.map((row) =>
                row.action ? (
                    <button
                        key={row.tui}
                        type="button"
                        role="menuitem"
                        className="agent-tui-item"
                        data-testid={`tui-switch-${row.tui}`}
                        onClick={() => onPick(row.tui)}
                    >
                        <Mark provider={row.tui} />
                        <span className="agent-tui-label">{row.label}</span>
                        <span className="agent-tui-state">
                            {row.state === 'sidecar' ? 'sidecar' : ''}
                        </span>
                    </button>
                ) : (
                    /* No action: either the driver in the chair, or one this
                       agent's AGENT.md excludes. Neither is a button — the
                       first would change nothing, the second could only be
                       refused. */
                    <div
                        key={row.tui}
                        className={`agent-tui-item is-static${
                            row.state === 'active' ? ' is-fronted' : ''
                        }`}
                        data-testid={
                            row.refusal ? `tui-refused-${row.tui}` : `tui-active-${row.tui}`
                        }
                        title={row.refusal ?? undefined}
                    >
                        <Mark provider={row.tui} />
                        <span className="agent-tui-label">{row.label}</span>
                        <span className="agent-tui-state">
                            {row.state === 'active' ? 'active' : 'not permitted'}
                        </span>
                    </div>
                ),
            )}
            {switchError && (
                <div className="agent-tui-note is-error" data-testid="tui-switch-error">
                    {switchError}
                </div>
            )}
            <div className="agent-tui-note">
                Switching keeps this agent — its inbox, history and prompt. The TUI you leave
                keeps its conversation as a sidecar; nothing is stopped.
            </div>
            <div className="agent-tui-head">Avatar</div>
            <div className="agent-tui-avatar">
                <input
                    className="input"
                    value={mark}
                    onChange={(e) => onMark(e.target.value)}
                    placeholder="Emoji — empty uses the driver's logo"
                    aria-label="Agent avatar"
                    spellCheck={false}
                />
            </div>
            <div className={`agent-tui-note${markError ? ' is-error' : ''}`}>
                {markError ??
                    'Shown wherever this agent appears. Clear it to go back to the driver’s own mark.'}
            </div>
        </>
    );
}

function Mark({ provider }: { provider: string }) {
    const mark = providerBrandMark(provider);
    return mark ? (
        <BrandMark name={mark} size={13} />
    ) : (
        <span className="agent-tui-initial">{provider.slice(0, 1).toUpperCase()}</span>
    );
}
