import { Chart } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { PULSE_SLOTS, agentPulse, pulseTickMs, type PulseMarkerKind } from '../../core/agent-pulse.js';
import type { TimedEvent } from '../../core/stream-view.js';

/**
 * THE AGENT PULSE (beta.64): the last minute of the agent's work, in the agent view's tab row. The model and why it
 * is cheap are in `core/agent-pulse.ts`; this draws it.
 *
 * The slot is ALWAYS 120 x 20, drawn or not, so the tab row never moves when an agent starts or stops. The redraw
 * clock is `pulseTickMs`'s decision: none for an idle agent with a quiet minute, none while the window is hidden.
 */

export interface AgentPulseProps {
    rows: readonly TimedEvent[];
    working: boolean;
    now: () => number;
}

const MARKER: Record<PulseMarkerKind, { label: string; className: string }> = {
    edit: { label: 'edit', className: 'bg-[var(--success)]' },
    mail: { label: 'mail', className: 'bg-[var(--primary)]' },
    question: { label: 'question', className: 'bg-[var(--warning)]' },
};

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function AgentPulse({ rows, working, now }: AgentPulseProps) {
    const [, setTick] = useState(0);
    const pulse = agentPulse(rows, now());
    const every = pulseTickMs(pulse, working, !hidden());

    useEffect(() => {
        if (every === null) return undefined;
        const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), every);
        return () => clearInterval(id);
    }, [every]);

    // Back from hidden: one redraw, which re-decides the clock.
    useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onVisible = (): void => { if (!hidden()) setTick((t) => (t + 1) % 1_000_000); };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, []);

    const total = pulse.counts.reduce((a, b) => a + b, 0);
    const state = working ? 'working' : pulse.quiet ? 'quiet' : 'idle';
    return (
        <span
            data-agent-pulse={state}
            title={pulse.quiet ? 'Nothing in the last minute' : `${total} in the last minute`}
            className={`relative inline-flex w-[120px] h-5 shrink-0 items-center ${working ? 'text-[var(--success)]' : 'text-[var(--fg-4)]'}`}
        >
            {pulse.quiet ? null : <Chart.Sparkline data={[...pulse.counts]} width={120} height={20} min={0} color="currentColor" />}
            {pulse.markers.map((m) => (
                <i
                    key={`${m.slot}:${m.kind}`}
                    data-pulse-marker={m.kind}
                    data-count={m.n}
                    title={m.n > 1 ? `${m.n} ${MARKER[m.kind].label}s` : MARKER[m.kind].label}
                    className={`absolute top-0 size-1 -translate-x-1/2 rounded-full ${MARKER[m.kind].className}`}
                    style={{ left: `${(m.slot / (PULSE_SLOTS - 1)) * 100}%` }}
                />
            ))}
        </span>
    );
}
