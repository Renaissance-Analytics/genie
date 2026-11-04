import type { TrustStepView } from '../features.js';

/** Skeleton: the tests come first. */
export type TrustPhase = { kind: 'idle' } | { kind: 'pending' } | { kind: 'failed'; reason: string };

export function TrustStepBody(_props: { step: TrustStepView; phase: TrustPhase; onTrust: () => void }) {
    return null;
}
