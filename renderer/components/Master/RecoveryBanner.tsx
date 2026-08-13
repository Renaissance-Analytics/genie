import { recoveryBannerMessage, type RecoveryState } from '../../lib/host-loss-recovery';

interface Props {
    /** null hides the banner. */
    state: RecoveryState | null;
    onDismiss: () => void;
}

/**
 * The host-loss recovery banner (genie#203, Fix C). Shown while the shared
 * pty-host is being recovered after a mid-session death, then settles to the
 * outcome; click to dismiss. Extracted from master.tsx so the E2E harness mounts
 * the SAME component the master window renders.
 */
export default function RecoveryBanner({ state, onDismiss }: Props) {
    if (!state) return null;
    return (
        <div className="g-toast" role="status" data-testid="recovery-banner" onClick={onDismiss}>
            {recoveryBannerMessage(state)}
        </div>
    );
}
