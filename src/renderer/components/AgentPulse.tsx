import type { TimedEvent } from '../../core/stream-view.js';

export interface AgentPulseProps {
    rows: readonly TimedEvent[];
    working: boolean;
    now: () => number;
}

/** STUB: drawn in GREEN. */
export function AgentPulse(_props: AgentPulseProps) {
    return null;
}
