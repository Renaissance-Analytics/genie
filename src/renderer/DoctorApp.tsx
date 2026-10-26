import { Skeleton } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { chatThreadFrom } from '../core/chat-view.js';
import { composerMeter } from '../core/composer.js';
import { parseRoute } from '../core/route.js';
import type { Fidelity } from '../core/dashboard-view.js';
import type { OsaFacts } from '../core/osa-home.js';
import type { Attachment } from '../core/prompt-content.js';
import type { LiveSession } from '../core/roster.js';
import type { TimedEvent } from '../core/stream-view.js';
import { AgentView } from './components/AgentView.js';
import { ChatFlyout } from './components/ChatFlyout.js';
import { GenieLogo } from './components/GenieLogo.js';
import { useComposerFocusLog } from './composer-focus-log.js';

/**
 * THE DOCTOR WINDOW (`genie --doctor`, the owner 2026-10-12): Genie with only the Genie OSA. The facts of the install,
 * genie's Stream (thoughts, tool calls — what it is doing) beside its chat (what it says, and the composer), and the line
 * Claude Code connects with. Nothing of Genie's rail, Dashboard or workspaces: doctor mode has not opened any of it.
 */
export interface DoctorDetail {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity; cwd: string };
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    turns: number;
    cost: number | null;
}

/** What the doctor window's preload exposes as `window.genieDoctor`. */
export interface DoctorBridge {
    facts(): Promise<OsaFacts>;
    /** The `claude mcp add …` line; `null` until the channel is listening. */
    connect(): Promise<string | null>;
    detail(): Promise<DoctorDetail | null>;
    /** Your message, with the composer's files (picked, dropped or pasted) — sent as content blocks, as in Genie. */
    prompt(text: string, attachments?: readonly Attachment[]): Promise<boolean>;
    start(): Promise<{ ok: true } | { ok: false; reason: string }>;
    answerApproval(optionId: string, note?: string): Promise<boolean>;
    onChange(listener: () => void): () => void;
}

/** The facts drawn as text (Omarchy's skills are genie's, not a line on this screen). */
type TextFact = Exclude<keyof OsaFacts, 'omarchy'>;
const FACT_LABEL: Readonly<Record<TextFact, string>> = {
    version: 'Genie',
    platform: 'Platform',
    installDir: 'Installed in',
    genieHome: 'Genie’s data',
    userData: 'Per-user app folder',
};

export function DoctorApp({ facts, connect, detail, onSend, onStart, onAnswerApproval, answeringApproval = null }: {
    facts: OsaFacts | null;
    connect: string | null;
    /** `null` before the first read: a skeleton, never "not running". */
    detail: DoctorDetail | null;
    onSend: (text: string, attachments?: readonly Attachment[]) => void;
    onStart: () => void;
    onAnswerApproval: (optionId: string, note?: string) => void;
    answeringApproval?: string | null;
}) {
    // The composer taking the caret unasked is logged with its cause (genie#1235), as in Genie's own window.
    useComposerFocusLog();
    const [selected, setSelected] = useState<string | null>(null);
    // The Stream's own doors (the index column's `?at=<row>`) land here: the window has no router, only this view.
    const [at, setAt] = useState<string | null>(null);
    const running = detail?.session?.running === true;
    const thread = detail ? chatThreadFrom({ agent: detail.agent, session: detail.session, rows: detail.rows }, 'genie', [], Date.now) : null;
    return (
        <div data-doctor="" className="flex h-full flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="flex h-9 shrink-0 items-center gap-2.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3">
                <GenieLogo />
                <span className="text-[13px] font-semibold">Genie</span>
                <span className="rounded-sm bg-[var(--warning)]/15 px-1.5 font-mono text-[11px] text-[var(--warning)]">doctor mode</span>
                <span className="text-[12px] text-[var(--fg-3)]">Genie’s configuration and database are not open. Only genie is running.</span>
            </header>
            <section data-doctor-facts="" className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-b border-[var(--border-1)] px-4 py-2 text-[12px]">
                {facts
                    ? (Object.keys(FACT_LABEL) as TextFact[]).map((k) => (
                          <span key={k}><span className="text-[var(--fg-4)]">{FACT_LABEL[k]}</span> <span className="font-mono text-[var(--fg-2)]">{facts[k]}</span></span>
                      ))
                    : <Skeleton className="h-4 w-96" />}
                {connect ? (
                    <div data-doctor-connect="" className="flex w-full items-center gap-2">
                        <span className="text-[var(--fg-4)]">Connect Claude Code</span>
                        <code className="min-w-0 flex-1 truncate rounded bg-[var(--bg-2)] px-1.5 py-0.5 font-mono text-[11px] select-all">{connect}</code>
                    </div>
                ) : null}
            </section>
            {detail === null ? (
                <div data-doctor-loading="" className="flex flex-1 flex-col gap-2 p-4"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-6 w-2/3" /></div>
            ) : (
                <div className="flex min-h-0 flex-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                        {running ? null : (
                            <div data-doctor-start="" className="flex shrink-0 items-center gap-3 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-2 text-[13px]">
                                <span>genie is not running{detail.session?.failure ? ` — ${detail.session.failure.reason}` : ''}.</span>
                                <button type="button" onClick={onStart} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[12px] hover:bg-[var(--bg-2)]">Start genie</button>
                            </div>
                        )}
                        <AgentView
                            agent={detail.agent}
                            session={detail.session}
                            rows={detail.rows}
                            tab="stream"
                            lanes={null}
                            at={at}
                            selectedId={selected}
                            turns={detail.turns}
                            cost={detail.cost}
                            onNavigate={(route) => { const r = parseRoute(route); if (r.surface === 'agent') setAt(r.at); }}
                            onSelect={setSelected}
                            chatInView
                        />
                    </div>
                    <ChatFlyout
                        thread={thread}
                        contextUsage={composerMeter(detail.session)}
                        approval={detail.session?.pendingApproval ?? null}
                        commands={detail.session?.extensions?.commands ?? null}
                        answeringApproval={answeringApproval}
                        onAnswerApproval={onAnswerApproval}
                        onSend={onSend}
                    />
                </div>
            )}
        </div>
    );
}
