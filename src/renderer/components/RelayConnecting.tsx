import { Icon } from '@particle-academy/react-fancy';
import { relayConnectView, type RelayConnect } from '../../core/relay-connect.js';

const STEP_ICON = { done: 'check', working: 'loader', failed: 'circle-alert', waiting: 'circle' } as const;
const STEP_TONE = { done: 'text-[var(--fg-2)]', working: 'text-[var(--fg-1)]', failed: 'text-[var(--danger)]', waiting: 'text-[var(--fg-4)]' } as const;

/**
 * A TYNN WORKSTATION'S WINDOW WHILE IT CONNECTS (core/relay-connect.ts): the machine's name, the three steps with where
 * each stands, and — on a failure — the sentence and a real Retry. No host field, no PIN, no ids: this window is bound
 * to one machine through Tynn, and the tailnet form is a different way in (Settings → Remote access).
 */
export function RelayConnecting({ name, state, onRetry }: { name: string | null; state: RelayConnect; onRetry: () => void }) {
    const view = relayConnectView(name, state);
    return (
        <div data-relay-connecting={state.kind} className="flex w-full max-w-sm flex-col items-center gap-5">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--bg-2)] text-[var(--fg-2)]"><Icon name="monitor" size="md" /></span>
            <h1 className="text-center text-base font-semibold break-words">{view.title}</h1>
            <ol className="flex w-full flex-col gap-2">
                {view.steps.map((s) => (
                    <li key={s.step} data-relay-step={s.step} data-status={s.status} className={`flex items-center gap-2.5 text-sm ${STEP_TONE[s.status]}`}>
                        <Icon name={STEP_ICON[s.status]} size="sm" className={s.status === 'working' ? 'animate-spin' : ''} />
                        <span className="break-words">{s.label}</span>
                    </li>
                ))}
            </ol>
            {view.problem !== null ? (
                <div data-problem="connect" className="flex w-full flex-col items-center gap-3 rounded-xl bg-[var(--bg-2)] px-4 py-3 text-center">
                    <p className="text-sm text-[var(--fg-1)]">{view.problem}</p>
                    <button
                        type="button"
                        data-action="retry-connect"
                        onClick={onRetry}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
                    >
                        <Icon name="refresh-cw" size="sm" />Retry
                    </button>
                </div>
            ) : null}
        </div>
    );
}
