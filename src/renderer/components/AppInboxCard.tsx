import { useState } from 'react';
import { Icon } from '@particle-academy/react-fancy';
import { ago } from '../../core/inbox-threads.js';
import type { AppSourceKind } from '../../core/app-inbox.js';
import { copyToClipboard } from '../clipboard.js';
import { APP_KIND_ICON } from './InboxFlyout.js';

/**
 * A WORKSPACE'S APPS AND SCRIPTS (genie#1345): what may report to its agents, and the person's hand on each key.
 *
 * - The sites and background processes that hold a key now, each by its icon and name, with Rotate and Revoke; a revoked
 *   one with Allow.
 * - The script keys the person made (the owner's D3), listed WITHOUT their secret, each with Revoke; and Make a key — its
 *   token shown ONCE, with Copy and how a script uses it.
 * - Every action shows it is in flight (its button busy and disabled) and then what happened — done, or failed with Retry
 *   (the owner, 2026-10-27: obvious actions, visible progress, never silent).
 *
 * Hook-light: everything on screen comes in as props, so a test renders every state.
 */

export interface AppInboxCardState {
    /** Where apps post (`GENIE_INBOX_URL`); `null` while the door is not listening. */
    readonly url: string | null;
    /** The workspace's "Apps and scripts may message agents here". */
    readonly enabled: boolean;
    readonly sources: readonly { readonly kind: AppSourceKind; readonly id: string; readonly name: string }[];
    readonly revoked: readonly { readonly kind: AppSourceKind; readonly id: string; readonly name?: string | undefined }[];
    readonly scriptKeys: readonly { readonly id: string; readonly name: string; readonly createdAt: string; readonly lastUsedAt: string | null }[];
}

export type AppInboxAction = 'rotate' | 'revoke' | 'allow' | 'create' | 'revoke-key';

export interface AppInboxCardProps {
    readonly state: AppInboxCardState | null;
    /** The action in flight, and on what (`site:<id>`, `process:<id>`, `key:<id>`, `create`). */
    readonly busy: { readonly action: AppInboxAction; readonly target: string } | null;
    /** A key just made: its token, shown this once. */
    readonly revealed: { readonly name: string; readonly token: string } | null;
    readonly outcome: { readonly ok: boolean; readonly text: string; readonly retry?: (() => void) | undefined } | null;
    readonly now: number;
    readonly onCreateKey: (name: string) => void;
    readonly onRevokeKey: (id: string) => void;
    readonly onRotate: (kind: AppSourceKind, id: string) => void;
    readonly onRevoke: (kind: AppSourceKind, id: string) => void;
    readonly onAllow: (kind: AppSourceKind, id: string) => void;
    readonly onDismissReveal: () => void;
}

const BTN = 'inline-flex items-center gap-1 rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)] disabled:cursor-wait disabled:opacity-60';

function ActionButton(p: { action: string; busy: boolean; anyBusy: boolean; icon: string; label: string; title: string; onClick: () => void }) {
    return (
        <button type="button" data-action={p.action} data-busy={p.busy ? 'true' : undefined} disabled={p.anyBusy} title={p.title} onClick={p.onClick} className={BTN}>
            <Icon name={p.busy ? 'loader-circle' : p.icon} size="xs" {...(p.busy ? { className: 'animate-spin' } : {})} />
            <span>{p.label}</span>
        </button>
    );
}

export function AppInboxCard(p: AppInboxCardProps) {
    const [name, setName] = useState('');
    const [copied, setCopied] = useState<boolean | null>(null);
    const s = p.state;
    const anyBusy = p.busy !== null;
    const isBusy = (action: AppInboxAction, target: string) => p.busy?.action === action && p.busy.target === target;
    if (s === null) {
        return (
            <div data-app-inbox-skeleton="" className="mt-2 flex flex-col gap-1">
                <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--bg-2)]" />
                <div className="h-3 w-1/4 animate-pulse rounded bg-[var(--bg-2)]" />
            </div>
        );
    }
    return (
        <div data-app-inbox-card="" className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-3)]">
                <Icon name="link" size="xs" />
                <span className="font-mono text-[var(--fg-2)]">{s.url ?? 'not listening'}</span>
                <span>· each posts with its own GENIE_INBOX_TOKEN</span>
            </p>
            {p.outcome ? (
                <p data-app-outcome={p.outcome.ok ? 'ok' : 'failed'} role={p.outcome.ok ? 'status' : 'alert'} className={`flex items-center gap-2 text-xs ${p.outcome.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                    <Icon name={p.outcome.ok ? 'circle-check' : 'circle-x'} size="xs" />
                    <span>{p.outcome.text}</span>
                    {!p.outcome.ok && p.outcome.retry ? <button type="button" data-action="app-retry" onClick={p.outcome.retry} className={BTN}><Icon name="rotate-cw" size="xs" /><span>Retry</span></button> : null}
                </p>
            ) : null}
            {!s.enabled ? (
                <p data-app-inbox-off="" className="flex items-center gap-2 text-xs text-[var(--fg-3)]">
                    <Icon name="ban" size="xs" />
                    <span>Off here: no site, process or script holds a key. Turn on “Apps and scripts may message agents here” above.</span>
                </p>
            ) : (
                <>
                    <ul data-app-sources="" className="divide-y divide-[var(--border-1)]">
                        {s.sources.length === 0 && s.revoked.length === 0 ? <li className="py-1 text-xs text-[var(--fg-3)]">No site or background process is running here yet.</li> : null}
                        {s.sources.map((src) => {
                            const target = `${src.kind}:${src.id}`;
                            return (
                                <li key={target} data-app-source={target} className="flex items-center gap-2 py-1">
                                    <span data-app-icon={APP_KIND_ICON[src.kind]} className="inline-flex text-[var(--fg-3)]"><Icon name={APP_KIND_ICON[src.kind]} size="sm" /></span>
                                    <span className="font-medium">{src.name}</span>
                                    <span className="ml-auto" />
                                    <ActionButton action="app-rotate" busy={isBusy('rotate', target)} anyBusy={anyBusy} icon="rotate-cw" label="Rotate" title={`A new key for ${src.name}; it restarts with it, and the old one stops working at once`} onClick={() => p.onRotate(src.kind, src.id)} />
                                    <ActionButton action="app-revoke" busy={isBusy('revoke', target)} anyBusy={anyBusy} icon="ban" label="Revoke" title={`${src.name} loses its key now and gets none until you allow it again`} onClick={() => p.onRevoke(src.kind, src.id)} />
                                </li>
                            );
                        })}
                        {s.revoked.map((src) => {
                            const target = `${src.kind}:${src.id}`;
                            return (
                                <li key={target} data-app-revoked={target} className="flex items-center gap-2 py-1 text-[var(--fg-3)]">
                                    <span data-app-icon={APP_KIND_ICON[src.kind]} className="inline-flex"><Icon name={APP_KIND_ICON[src.kind]} size="sm" /></span>
                                    <span className="line-through">{src.name ?? src.id}</span>
                                    <Icon name="ban" size="xs" />
                                    <span className="ml-auto" />
                                    <ActionButton action="app-allow" busy={isBusy('allow', target)} anyBusy={anyBusy} icon="circle-check" label="Allow" title={`${src.name ?? src.id} gets a key again on its next start`} onClick={() => p.onAllow(src.kind, src.id)} />
                                </li>
                            );
                        })}
                    </ul>
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-xs font-medium"><Icon name="key-round" size="xs" /><span>Script keys</span><span className="font-normal text-[var(--fg-4)]">for scripts outside Genie: cron, CI</span></div>
                        <ul className="divide-y divide-[var(--border-1)]">
                            {s.scriptKeys.map((k) => (
                                <li key={k.id} data-script-key={k.id} className="flex items-center gap-2 py-1">
                                    <span data-app-icon="key-round" className="inline-flex text-[var(--fg-3)]"><Icon name="key-round" size="sm" /></span>
                                    <span className="font-medium">{k.name}</span>
                                    <span className="text-[11px] text-[var(--fg-4)]">{k.lastUsedAt ? `used ${ago(Date.parse(k.lastUsedAt), p.now)} ago` : 'never used'}</span>
                                    <span className="ml-auto" />
                                    <ActionButton action="script-key-revoke" busy={isBusy('revoke-key', `key:${k.id}`)} anyBusy={anyBusy} icon="ban" label="Revoke" title={`${k.name} stops working at once`} onClick={() => p.onRevokeKey(k.id)} />
                                </li>
                            ))}
                        </ul>
                        {p.revealed ? (
                            <div data-script-key-revealed="" className="flex flex-col gap-1 rounded-md border border-[var(--warning)] p-2 text-xs">
                                <span className="font-medium">{`${p.revealed.name}: shown once — copy it now; Genie keeps only its hash`}</span>
                                <span className="flex items-center gap-2">
                                    <code className="min-w-0 flex-1 select-all break-all font-mono">{p.revealed.token}</code>
                                    <button type="button" data-action="script-key-copy" className={BTN} onClick={() => { void copyToClipboard({ plain: p.revealed!.token }).then(setCopied); }}>
                                        <Icon name={copied === true ? 'check' : copied === false ? 'x' : 'copy'} size="xs" />
                                        <span>{copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy'}</span>
                                    </button>
                                    <button type="button" data-action="script-key-done" className={BTN} onClick={() => { setCopied(null); p.onDismissReveal(); }}>Done</button>
                                </span>
                                <span className="text-[var(--fg-3)]">{`Your script sets GENIE_INBOX_TOKEN to it and posts JSON { "subject", "body" } to ${s.url ?? 'the address above'}/v1/inbox with "Authorization: Bearer $GENIE_INBOX_TOKEN".`}</span>
                            </div>
                        ) : null}
                        <form data-form="script-key-create" className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { p.onCreateKey(name.trim()); setName(''); } }}>
                            <input aria-label="New script key name" value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-check" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-0.5 font-mono text-xs" />
                            <button type="submit" data-action="script-key-create" data-busy={isBusy('create', 'create') ? 'true' : undefined} disabled={anyBusy || !name.trim()} className={BTN}>
                                <Icon name={isBusy('create', 'create') ? 'loader-circle' : 'key-round'} size="xs" {...(isBusy('create', 'create') ? { className: 'animate-spin' } : {})} />
                                <span>Make a key</span>
                            </button>
                        </form>
                    </div>
                </>
            )}
        </div>
    );
}
