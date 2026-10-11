import { Icon } from '@particle-academy/react-fancy';
import { onboardingPlan, type OnboardingState } from '../../core/settings.js';

/**
 * ONBOARDING (§6.9) — two steps, two decisions: pick a folder, meet an agent. Everything else is a
 * LINE with a route to fix it, never a gate: no provider, no GitHub, no Tynn are reported and
 * clickable, and none of them stops the steps. When both steps are done this renders NOTHING — the
 * Dashboard is the screen, and an onboarding frame over a working estate would be a breadcrumb.
 */

export interface OnboardingProps {
    readonly state: OnboardingState;
    readonly onAddWorkspace: () => void;
    /** The other source (§6.1): clone a git URL into a folder you pick, plan first. */
    readonly onAddWorkspaceFromGit?: (() => void) | undefined;
    readonly onAddAgent: () => void;
    readonly onNavigate: (route: string) => void;
}

export function Onboarding({ state, onAddWorkspace, onAddWorkspaceFromGit, onAddAgent, onNavigate }: OnboardingProps) {
    const plan = onboardingPlan(state);
    if (plan.done) return null;
    const folderDone = state.workspaces > 0;
    const steps = [
        { id: 'pick-folder' as const, label: 'Pick a folder to work in', done: folderDone, active: !folderDone, action: onAddWorkspace, button: 'Pick a folder' },
        { id: 'meet-agent' as const, label: 'Meet your first agent', done: state.agents > 0, active: folderDone && state.agents === 0, action: onAddAgent, button: 'Add an agent' },
    ];

    return (
        <section data-onboarding className="mx-auto flex max-w-xl flex-col gap-4 p-7">
            <h2 className="text-lg font-semibold tracking-tight">Two steps to a working agent</h2>
            <ol className="flex flex-col gap-2">
                {steps.map((s, i) => (
                    <li key={s.id} data-step={s.id} data-active={s.active ? 'true' : 'false'} data-done={s.done ? 'true' : 'false'} className={`flex items-center gap-3 rounded-xl border border-[var(--border-1)] px-4 py-3 ${s.active ? 'bg-[var(--bg-1)]' : 'opacity-70'}`}>
                        <span className="font-mono text-xs text-[var(--fg-4)]">{i + 1}</span>
                        <span className="flex-1 text-sm">{s.label}</span>
                        {s.done ? <Icon name="check" size="xs" /> : (
                            <button type="button" disabled={!s.active} onClick={s.action} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                                {s.button}
                            </button>
                        )}
                        {s.id === 'pick-folder' && !s.done && onAddWorkspaceFromGit ? (
                            <button type="button" data-action="add-from-git" onClick={onAddWorkspaceFromGit} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]">From a git URL</button>
                        ) : null}
                    </li>
                ))}
            </ol>
            {plan.lines.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm text-[var(--fg-3)]">
                    {plan.lines.map((l) => (
                        <li key={l.id} data-line={l.id} className="flex items-center gap-2">
                            <span className="flex-1">{l.label}</span>
                            <button type="button" data-route={l.route} onClick={() => onNavigate(l.route)} className="text-[13px] underline-offset-2 hover:underline">Fix</button>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
