import { Icon, Modal } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { CONNECT_EMPTY_GUIDANCE, type ConnectProgress } from '../../core/connect-machine.js';
import type { RoleChange, TynnWorkstationList, TynnWorkstationRow } from '../relay-transport.js';

type OpenWorkstation = (workstation: TynnWorkstationRow) => void | Promise<unknown>;

/**
 * Opening a workstation, with where each one stands: its step while its window opens, then "opened" or the reason. The
 * connection itself shows in that window (App.tsx's "Connecting to …" screen, with Reconnect).
 */
export function useOpenProgress(open: OpenWorkstation | undefined): [Readonly<Record<string, ConnectProgress>>, ((workstation: TynnWorkstationRow) => void) | undefined] {
    const [opening, setOpening] = useState<Readonly<Record<string, ConnectProgress>>>({});
    if (!open) return [opening, undefined];
    const set = (id: string, state: ConnectProgress) => setOpening((now) => ({ ...now, [id]: state }));
    return [opening, (w) => {
        set(w.id, { kind: 'working', step: 'Opening its window…' });
        Promise.resolve()
            .then(() => open(w))
            .then(
                () => set(w.id, { kind: 'done', note: 'Opened in its own window' }),
                (error: unknown) => set(w.id, { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }),
            );
    }];
}

const BUTTON = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1 text-[13px] font-medium hover:bg-[var(--bg-2)] disabled:cursor-default disabled:opacity-60';

/**
 * Where an action stands, under it: its step while working, what happened, or the reason with Retry (the owner,
 * 2026-10-27: real buttons, a visible in-progress step, then success or failure with Retry; never silent).
 */
function Progress({ state, onRetry, retryAction }: { state: ConnectProgress; onRetry: () => void; retryAction: string }) {
    if (state.kind === 'working') {
        return <span data-connect-step="" className="flex items-center gap-1.5 text-xs text-[var(--fg-3)]"><Icon name="loader" size="xs" className="animate-spin" />{state.step}</span>;
    }
    if (state.kind === 'done') {
        return <span data-connect-done="" className="flex items-center gap-1.5 text-xs text-[var(--fg-2)]"><Icon name="check" size="xs" />{state.note}</span>;
    }
    if (state.kind === 'failed') {
        return (
            <span data-problem="connect" className="flex flex-wrap items-center gap-2 text-xs text-[var(--danger)]">
                <span>{state.reason}</span>
                <button type="button" data-action={retryAction} onClick={onRetry} className={BUTTON}><Icon name="refresh-cw" size="xs" />Retry</button>
            </span>
        );
    }
    return null;
}

/**
 * YOUR TYNN WORKSTATIONS (Tynn #837; Genie 1's HostsPanel, v0.7.0-beta.342 renderer/pages/master.tsx:4879): a row per
 * machine Tynn says this person can see. One Tynn says you may reach has Open, which opens it in its own window over the
 * Tynn relay; one you may not is shown with the reason, and has no Open. `opening` is where each Open stands.
 *
 * EMPTY IS NEVER BLANK: no machines, or Tynn could not be asked, shows the steps to take on the other machine, after
 * Tynn's own reason when it gave one.
 */
type SetRole = (workstation: TynnWorkstationRow, role: 'pilot' | 'drone', code: string) => Promise<RoleChange>;

const ROLE_ICON = { pilot: 'navigation', drone: 'bot' } as const;
const ROLE_NAME = { pilot: 'Pilot', drone: 'Drone' } as const;

/**
 * THE CODE PROMPT FOR A ROLE CHANGE (genie#1278 W6): what will change, the authenticator code, Confirm; then its step,
 * and success, or Tynn's reason with Retry. Tynn checks the code; this only collects it.
 */
export function RoleChangeForm({ to, name, code, state, onCode, onConfirm, onCancel }: {
    to: 'pilot' | 'drone';
    name: string;
    code: string;
    state: ConnectProgress;
    onCode: (code: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const ready = /^[0-9]{6}$/.test(code.replace(/[ -]/g, ''));
    return (
        <form
            data-form="change-role"
            className="flex flex-col gap-1.5 rounded-md bg-[var(--bg-2)] p-2 text-xs"
            onSubmit={(e) => { e.preventDefault(); if (ready && state.kind !== 'working') onConfirm(); }}
        >
            <span className="flex items-center gap-1.5 text-[var(--fg-2)]">
                <Icon name={ROLE_ICON[to]} size="xs" />
                Make {name} a {to}. {to === 'drone' ? 'It can no longer open other workstations.' : 'It can open your other workstations.'}
            </span>
            <div className="flex items-center gap-2">
                <span className="flex shrink-0 text-[var(--fg-3)]" title="Authenticator code" aria-label="Authenticator code"><Icon name="shield-check" size="xs" /></span>
                <input
                    data-role-code=""
                    aria-label="Authenticator code"
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={9}
                    value={code}
                    onChange={(e) => onCode(e.target.value)}
                    className="w-24 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 font-mono tracking-widest"
                />
                <button type="submit" data-action="confirm-role" disabled={!ready || state.kind === 'working'} className={BUTTON}>Confirm</button>
                <button type="button" data-action="cancel-role" onClick={onCancel} aria-label="Cancel" title="Cancel" className="rounded-md p-1 text-[var(--fg-3)] hover:bg-[var(--bg-1)]"><Icon name="x" size="xs" /></button>
            </div>
            <Progress state={state} onRetry={onConfirm} retryAction="retry-role" />
        </form>
    );
}

export function TynnWorkstationRows({ list, onOpenWorkstation, opening = {}, onSetRole }: {
    list: TynnWorkstationList;
    onOpenWorkstation?: ((workstation: TynnWorkstationRow) => void) | undefined;
    opening?: Readonly<Record<string, ConnectProgress>> | undefined;
    /** A pilot only (genie#1278 W6): change a workstation's role with an authenticator code. */
    onSetRole?: SetRole | undefined;
}) {
    // The one row whose role is being changed, its code and where the change stands.
    const [changing, setChanging] = useState<{ id: string; to: 'pilot' | 'drone'; code: string; state: ConnectProgress } | null>(null);
    // What Tynn answered, until the list is read again.
    const [changed, setChanged] = useState<Readonly<Record<string, 'pilot' | 'drone'>>>({});
    if (!list.ok || list.workstations.length === 0) {
        return (
            <div data-tynn-workstations={list.ok ? 'empty' : 'unavailable'} className="flex flex-col gap-1 text-xs text-[var(--fg-3)]">
                {list.ok ? null : <p data-tynn-reason="">{list.reason}.</p>}
                <p data-connect-guidance="">{CONNECT_EMPTY_GUIDANCE}</p>
            </div>
        );
    }
    return (
        <ul data-tynn-workstations="" className="flex flex-col gap-1">
            {list.workstations.map((w) => {
                const state = opening[w.id] ?? { kind: 'idle' as const };
                const role = changed[w.id] ?? w.role ?? null;
                // Only your own desktops: a cloud machine is always a drone, and one shared with you is not yours to change.
                const switchable = onSetRole !== undefined && w.local && w.source === 'owner' && role !== null;
                const confirm = (to: 'pilot' | 'drone', code: string) => {
                    if (!onSetRole) return;
                    setChanging({ id: w.id, to, code, state: { kind: 'working', step: 'Asking Tynn…' } });
                    onSetRole(w, to, code).then(
                        (r) => {
                            if (r.ok) setChanged((now) => ({ ...now, [w.id]: r.role }));
                            setChanging((now) => (now?.id === w.id ? { ...now, code: r.ok ? '' : now.code, state: r.ok ? { kind: 'done', note: `${w.name} is now a ${r.role}` } : { kind: 'failed', reason: r.reason } } : now));
                        },
                        (error: unknown) => setChanging((now) => (now?.id === w.id ? { ...now, state: { kind: 'failed', reason: error instanceof Error ? error.message : String(error) } } : now)),
                    );
                };
                return (
                    <li key={w.id} data-tynn-workstation-row={w.id} className="flex flex-col gap-1 rounded-lg border border-[var(--border-1)] px-3 py-2 text-[13px]">
                        <div className="flex items-center gap-2">
                            {/* Desktop or cloud is a glyph, named for a screen reader and on hover (the owner's reduce-reading rule). */}
                            <span title={w.local ? 'Desktop' : 'Cloud'} aria-label={w.local ? 'Desktop' : 'Cloud'} className="flex shrink-0 text-[var(--fg-3)]">
                                <Icon name={w.local ? 'monitor' : 'cloud'} size="xs" />
                            </span>
                            <span className="truncate font-medium">{w.name}</span>
                            {role ? (
                                <span data-workstation-role={role} title={ROLE_NAME[role]} aria-label={ROLE_NAME[role]} className="flex shrink-0 text-[var(--fg-3)]"><Icon name={ROLE_ICON[role]} size="xs" /></span>
                            ) : null}
                            {switchable && role ? (
                                <button type="button" data-action="change-role" onClick={() => setChanging({ id: w.id, to: role === 'pilot' ? 'drone' : 'pilot', code: '', state: { kind: 'idle' } })} className={BUTTON}>
                                    <Icon name={ROLE_ICON[role === 'pilot' ? 'drone' : 'pilot']} size="xs" />Make {role === 'pilot' ? 'drone' : 'pilot'}
                                </button>
                            ) : null}
                            {w.source && w.source !== 'owner' ? <span title="Shared with you" aria-label="Shared with you" className="flex shrink-0 text-[var(--fg-4)]"><Icon name="link" size="xs" /></span> : null}
                            {w.connectable && onOpenWorkstation ? (
                                <button type="button" data-action="open-workstation" disabled={state.kind === 'working'} onClick={() => onOpenWorkstation(w)} className={`ml-auto shrink-0 ${BUTTON}`}>Open</button>
                            ) : (
                                <span className="ml-auto shrink-0 text-[11px] text-[var(--fg-3)]">{!w.active ? 'not active' : 'not shared with you'}</span>
                            )}
                        </div>
                        {onOpenWorkstation ? <Progress state={state} onRetry={() => onOpenWorkstation(w)} retryAction="retry-workstation" /> : null}
                        {changing?.id === w.id ? (
                            <RoleChangeForm
                                to={changing.to}
                                name={w.name}
                                code={changing.code}
                                state={changing.state}
                                onCode={(code) => setChanging((now) => (now ? { ...now, code, state: now.state.kind === 'working' ? now.state : { kind: 'idle' } } : now))}
                                onConfirm={() => confirm(changing.to, changing.code)}
                                onCancel={() => setChanging(null)}
                            />
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

/** Paste a share link and open it: a field, a real Open button, then its progress (core/connect-link.ts decides). */
export function ShareLinkForm({ value, state, onChange, onOpen }: { value: string; state: ConnectProgress; onChange: (value: string) => void; onOpen: () => void }) {
    return (
        <form
            data-form="open-share-link"
            className="flex flex-col gap-2"
            onSubmit={(e) => { e.preventDefault(); if (value.trim() !== '' && state.kind !== 'working') onOpen(); }}
        >
            <div className="flex items-center gap-2">
                <span className="flex shrink-0 text-[var(--fg-3)]"><Icon name="link" size="sm" /></span>
                <input
                    data-share-link-input=""
                    aria-label="Share link"
                    placeholder="https://tynn.ai/invites/accept/…"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1 font-mono text-xs"
                />
                <button type="submit" data-action="open-share-link" disabled={value.trim() === '' || state.kind === 'working'} className={BUTTON}>Open</button>
            </div>
            <Progress state={state} onRetry={onOpen} retryAction="retry-share-link" />
        </form>
    );
}

export interface ConnectMenuProps {
    /** What Tynn listed; `null` = not read yet (said as such, never as an empty list). */
    readonly workstations: TynnWorkstationList | null;
    readonly onOpenWorkstation?: OpenWorkstation | undefined;
    /** Settings → Remote access: the full page, where host and PIN live. */
    readonly onOpenSurface: () => void;
    /** Paste a share link instead. */
    readonly onOpenLink?: (() => void) | undefined;
    /** A pilot only (genie#1278 W6). */
    readonly onSetRole?: SetRole | undefined;
}

/** The title bar's menu and the Command Window's "Connect to my workstations": your machines first, then the other ways. */
export function ConnectMenu({ workstations, onOpenWorkstation, onOpenSurface, onOpenLink, onSetRole }: ConnectMenuProps) {
    const [opening, open] = useOpenProgress(onOpenWorkstation);
    const quiet = 'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]';
    return (
        <div data-connect-menu="" className="flex w-80 flex-col gap-2 p-2 text-sm">
            {workstations === null ? (
                <p data-tynn-workstations="loading" className="flex items-center gap-1.5 text-xs text-[var(--fg-3)]"><Icon name="loader" size="xs" className="animate-spin" />Asking Tynn for your machines…</p>
            ) : (
                <TynnWorkstationRows list={workstations} onOpenWorkstation={open} opening={opening} onSetRole={onSetRole} />
            )}
            <div className="flex items-center gap-1">
                {onOpenLink ? (
                    <button type="button" data-action="paste-share-link" onClick={onOpenLink} className={quiet}><Icon name="link" size="xs" />Share link</button>
                ) : null}
                <button type="button" data-action="open-connect-surface" onClick={onOpenSurface} className={quiet}><Icon name="settings" size="xs" />Remote access</button>
            </div>
        </div>
    );
}

/**
 * THE COMMAND WINDOW'S TWO WAYS IN (genie#1278 C1), in a window of their own: "Open a share link…" (paste, Open, its
 * progress) and "Connect to my workstations" (the same menu as the title bar's button).
 */
export function ConnectDialog({ mode, onClose, workstations, onOpenWorkstation, onOpenSurface, openLink, onSwitch, onSetRole }: {
    onSetRole?: SetRole | undefined;
    mode: 'link' | 'workstations';
    onClose: () => void;
    workstations: TynnWorkstationList | null;
    onOpenWorkstation?: OpenWorkstation | undefined;
    onOpenSurface: () => void;
    /** Main decides and acts (core/connect-link.ts); absent = this window cannot open links (not a desktop Genie). */
    openLink?: ((text: string) => Promise<{ ok: boolean; note: string }>) | undefined;
    onSwitch: (mode: 'link' | 'workstations') => void;
}) {
    const [value, setValue] = useState('');
    const [state, setState] = useState<ConnectProgress>({ kind: 'idle' });
    const open = () => {
        if (!openLink) { setState({ kind: 'failed', reason: 'Share links open from Genie on a desktop' }); return; }
        setState({ kind: 'working', step: 'Checking the link…' });
        openLink(value).then(
            (r) => setState(r.ok ? { kind: 'done', note: r.note } : { kind: 'failed', reason: r.note }),
            (error: unknown) => setState({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) }),
        );
    };
    return (
        <Modal open onClose={onClose} size="md">
            <Modal.Header>
                <span className="flex items-center gap-2"><Icon name={mode === 'link' ? 'link' : 'monitor'} size="sm" />{mode === 'link' ? 'Open a share link' : 'Your workstations'}</span>
            </Modal.Header>
            <Modal.Body>
                {mode === 'link' ? (
                    <ShareLinkForm value={value} state={state} onChange={(v) => { setValue(v); if (state.kind !== 'working') setState({ kind: 'idle' }); }} onOpen={open} />
                ) : (
                    <ConnectMenu workstations={workstations} onOpenWorkstation={onOpenWorkstation} onOpenSurface={onOpenSurface} onOpenLink={() => onSwitch('link')} onSetRole={onSetRole} />
                )}
            </Modal.Body>
        </Modal>
    );
}
