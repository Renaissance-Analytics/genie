import type { TimedEvent } from './stream-view.js';

/**
 * THE AGENT PULSE (beta.64): the last minute of one agent's work, drawn small in its agent view.
 *
 * Genie 1 drew a pulse behind each workspace in its sidebar. STUB: the model is written in GREEN.
 */

export const PULSE_SLOTS = 30;
export const PULSE_SLOT_MS = 2_000;
export const PULSE_WINDOW_MS = PULSE_SLOTS * PULSE_SLOT_MS;
export const PULSE_TICK_MS = PULSE_SLOT_MS;

export type PulseMarkerKind = 'edit' | 'mail' | 'question';
export const PULSE_MARKER_KINDS: readonly PulseMarkerKind[] = ['edit', 'mail', 'question'];

export interface PulseMarker { slot: number; kind: PulseMarkerKind; n: number }

export interface AgentPulseModel {
    counts: readonly number[];
    markers: readonly PulseMarker[];
    quiet: boolean;
}

export function agentPulse(_rows: readonly TimedEvent[], _now: number): AgentPulseModel {
    return { counts: [], markers: [], quiet: true };
}

export function pulseTickMs(_pulse: AgentPulseModel, _working: boolean, _visible: boolean): number | null {
    return null;
}
