import type { TailscaleRemedy, TailscaleStatus } from './genie';

/**
 * What Settings → Work Mode → Tailscale should render for a given status.
 *
 * PURE and DOM-free, so the decision that genie#380/#396 were actually about —
 * which label, and which affordance — is unit-tested rather than left inside
 * JSX. Before those issues the panel read only `installed`/`running`, so absent,
 * daemon-down, not-an-operator and not-logged-in all rendered as
 * "Installed · offline" and Genie offered to INSTALL Tailscale in three states
 * where it was already installed.
 */
export interface TailscalePanelView {
    /** The status line beside the section title. */
    label: string;
    tone: 'neutral' | 'ok' | 'warn' | 'bad';
    /** Only ever true when Tailscale is genuinely not on the machine. */
    showInstall: boolean;
    /** Installed but not up — `tailscale up` is worth a try. */
    showBringOnline: boolean;
    /** What is wrong and the command that fixes it; null once connected. */
    remedy: TailscaleRemedy | null;
}

export function tailscalePanelView(status: TailscaleStatus | null): TailscalePanelView {
    if (!status) {
        return {
            label: '—',
            tone: 'neutral',
            showInstall: false,
            showBringOnline: false,
            remedy: null,
        };
    }
    const { state } = status;
    const running = state === 'running';
    const selfIp = status.self?.ip ?? null;
    const label =
        state === 'absent'
            ? 'Not installed'
            : running
                ? `Connected${selfIp ? ` · ${selfIp}` : ''}`
                : state === 'stopped'
                    ? 'Installed · service not running'
                    : state === 'needs-operator'
                        ? 'Installed · not permitted'
                        : state === 'needs-login'
                            ? 'Installed · not connected'
                            : 'Installed · state unknown';
    return {
        label,
        tone: state === 'absent' ? 'bad' : running ? 'ok' : 'warn',
        showInstall: state === 'absent',
        showBringOnline: state !== 'absent' && !running,
        remedy: running ? null : (status.remedy ?? null),
    };
}
