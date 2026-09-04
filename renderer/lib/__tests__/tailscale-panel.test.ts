import { describe, it, expect } from 'vitest';
import { tailscalePanelView } from '../tailscale-panel';
import type { TailscaleStatus } from '../genie';

/**
 * genie#380 / genie#396 — what Settings → Work Mode → Tailscale RENDERS.
 *
 * The panel used to read `installed`/`running` only, so absent, daemon-down,
 * not-an-operator and not-logged-in all rendered as "Installed · offline", and
 * the Install button was offered for whichever of them Genie happened to be in
 * — the right remedy for exactly one. Keeping the decision pure means the
 * choice of label and affordances is tested, not just the strings behind it.
 */

function status(over: Partial<TailscaleStatus>): TailscaleStatus {
    return {
        installed: true,
        running: false,
        state: 'needs-login',
        self: null,
        peers: [],
        ...over,
    };
}

describe('tailscalePanelView', () => {
    it('offers Install ONLY when Tailscale is genuinely absent', () => {
        expect(tailscalePanelView(status({ state: 'absent', installed: false })).showInstall).toBe(
            true,
        );
        for (const state of ['stopped', 'needs-operator', 'needs-login', 'running'] as const) {
            expect(tailscalePanelView(status({ state })).showInstall).toBe(false);
        }
    });

    it('gives each blocked state its own label', () => {
        const label = (s: TailscaleStatus['state']) => tailscalePanelView(status({ state: s })).label;
        const labels = [
            label('absent'),
            label('stopped'),
            label('needs-operator'),
            label('needs-login'),
        ];
        // Four situations, four labels — the whole point of genie#380.
        expect(new Set(labels).size).toBe(4);
        expect(label('absent')).toMatch(/not installed/i);
        expect(label('stopped')).toMatch(/service/i);
    });

    it('shows the tailnet IP once connected', () => {
        const v = tailscalePanelView(
            status({
                state: 'running',
                running: true,
                self: { ip: '100.1.2.3', hostname: 'omarchy', online: true },
            }),
        );
        expect(v.label).toContain('100.1.2.3');
        expect(v.tone).toBe('ok');
        expect(v.showBringOnline).toBe(false);
        expect(v.showInstall).toBe(false);
    });

    it('offers Bring online for every installed-but-not-up state', () => {
        for (const state of ['stopped', 'needs-operator', 'needs-login'] as const) {
            expect(tailscalePanelView(status({ state })).showBringOnline).toBe(true);
        }
        expect(tailscalePanelView(status({ state: 'absent', installed: false })).showBringOnline).toBe(
            false,
        );
    });

    it('surfaces the remedy while offline and hides it once connected', () => {
        const remedy = { message: 'not running', command: 'sudo systemctl enable --now tailscaled' };
        expect(tailscalePanelView(status({ state: 'stopped', remedy })).remedy).toEqual(remedy);
        expect(
            tailscalePanelView(status({ state: 'running', running: true, remedy })).remedy,
        ).toBeNull();
    });

    it('renders a placeholder before the first status arrives', () => {
        const v = tailscalePanelView(null);
        expect(v.label).toBe('—');
        expect(v.showInstall).toBe(false);
        expect(v.showBringOnline).toBe(false);
        expect(v.tone).toBe('neutral');
    });
});
