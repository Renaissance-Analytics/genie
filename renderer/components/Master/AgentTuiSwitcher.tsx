import { useState } from 'react';
import { Popover } from '@particle-academy/react-fancy';
import { api } from '../../lib/genie';
import type { AgentRuntimeSpec } from '../../lib/ams-grid';
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
 * process and a conversation, so it stays an explicit, confirmed act elsewhere.
 */
export default function AgentTuiSwitcher({
    agentId,
    runtimes,
    onChanged,
    avatar,
}: {
    agentId: string;
    runtimes: AgentRuntimeSpec[];
    /** The agent's current mark, so the field opens showing what is set. */
    avatar?: string | null;
    onChanged: () => void;
}) {
    const [mark, setMark] = useState(avatar ?? '');
    const [markError, setMarkError] = useState<string | null>(null);
    const mine = runtimes.filter((r) => r.agentId === agentId);
    const fronted = mine.find((r) => r.fronted);
    const sidecars = mine.filter((r) => !r.fronted);

    const pick = (provider: string): void => {
        const existing = mine.find((r) => r.tui === provider);
        if (existing?.fronted) return; // already the visible one — not a relaunch
        void (existing
            ? api().agents.front(agentId, existing.id)
            : api().agents.addRuntime(agentId, provider)
        )
            .then(onChanged)
            .catch(() => {});
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
                <div className="agent-tui-head">Driver</div>
                {agentTerminalTypes().map((type) => {
                    const provider = type.agent as string;
                    const runtime = mine.find((r) => r.tui === provider);
                    return (
                        <button
                            key={provider}
                            type="button"
                            role="menuitem"
                            className={`agent-tui-item${runtime?.fronted ? ' is-fronted' : ''}`}
                            onClick={() => pick(provider)}
                        >
                            <Mark provider={provider} />
                            <span className="agent-tui-label">{type.label}</span>
                            <span className="agent-tui-state">
                                {runtime?.fronted
                                    ? 'active'
                                    : runtime
                                      ? 'sidecar'
                                      : ''}
                            </span>
                        </button>
                    );
                })}
                <div className="agent-tui-note">
                    Switching keeps this agent — its inbox, history and prompt. The TUI you
                    leave keeps its conversation as a sidecar; nothing is stopped.
                </div>
                <div className="agent-tui-head">Avatar</div>
                <div className="agent-tui-avatar">
                    <input
                        className="input"
                        value={mark}
                        onChange={(e) => saveMark(e.target.value)}
                        placeholder="Emoji — empty uses the driver's logo"
                        aria-label="Agent avatar"
                        spellCheck={false}
                    />
                </div>
                <div className={`agent-tui-note${markError ? ' is-error' : ''}`}>
                    {markError ??
                        'Shown wherever this agent appears. Clear it to go back to the driver’s own mark.'}
                </div>
            </Popover.Content>
        </Popover>
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
