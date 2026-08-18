import { useEffect, useState } from 'react';
import Chooser from '../components/Master/Chooser';
import { api, type WorkspaceRow } from '../lib/genie';

/**
 * E2E harness page for the AgentPulse sparkline's PAINT ORDER (genie#197).
 * NOT product UI.
 *
 * The bug: hovering a collapsed workspace row made the activity sparkline
 * vanish. `.tproj-head` has a TRANSPARENT background that becomes an OPAQUE
 * `var(--bg-2)` on `:hover`, and the sparkline used to be a SIBLING painted
 * behind the head — so the hover fill painted straight over it.
 *
 * WHY THIS MOUNTS THE REAL `Chooser` rather than hand-built markup: the fix is
 * not a rule in the stylesheet, it is a RELATIONSHIP between two things — the
 * sparkline must be a DESCENDANT of the element that grows the opaque hover
 * fill, carrying `z-index:-1` so it paints above that element's background but
 * below its text. A harness that rebuilt the markup itself would keep passing
 * if someone moved the sparkline back out of the head in `Chooser.tsx`, which
 * is exactly the regression this guards. So the component under test is the
 * real one, and the DOM it produces is the DOM the product ships.
 *
 * WHY `.gwrap`: every colour token — `--agent`, which the sparkline's fill and
 * stroke are mixed from, and `--bg-2`, the hover fill — is declared on `.gwrap`
 * / `.genie-overlay-root`, NOT on `:root` (master.css:102). Mounted outside that
 * wrapper the sparkline's `color-mix(in srgb, var(--agent) …)` resolves to
 * nothing, paints transparent, and a pixel test would go red for a reason that
 * has nothing to do with hovering. That is the genie#114 failure mode, and it is
 * why the wrapper is here rather than a bare `<div>`.
 *
 * The spec drives real `agent-pulse` broadcasts from MAIN (see
 * `__GENIE_E2E_PULSE__` in background.ts) so the ring fills through the same
 * preload channel a real terminal's bytes travel.
 */

const NOOP = () => {};

export default function E2EAgentPulse() {
    const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const list = await api().workspaces.list();
                if (!alive) return;
                const ws = list.filter((w) => w.id === 'e2e-agent-pulse');
                if (ws.length === 0) {
                    setError(
                        `seed missing: expected workspace "e2e-agent-pulse", got [${list
                            .map((w) => w.id)
                            .join(', ')}]`,
                    );
                    return;
                }
                setWorkspaces(ws);
            } catch (e) {
                if (alive) setError(`workspaces.list failed: ${String(e)}`);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    if (error) return <div data-testid="pulse-error">{error}</div>;
    if (workspaces.length === 0) return <div data-testid="pulse-loading">loading…</div>;

    return (
        // `.gwrap` carries the colour tokens; the width leaves room for the
        // 56px rail plus the 282px flyout so the row is laid out at its real size.
        <div className="gwrap" style={{ width: 420, padding: 0 }}>
            <Chooser
                workspaces={workspaces}
                specs={[]}
                selected={new Set()}
                activeIds={new Set()}
                attentionIds={new Set()}
                activeWorkspaceId={workspaces[0]!.id}
                // PINNED — the sidebar OPEN, which is the state the bug was
                // reported in. It is not cosmetic: `.chooser-flyout` is
                // `pointer-events: none` until `.chooser:hover` or
                // `.chooser.pinned` (master.css:1718), so an unpinned harness
                // has every click and hover fall straight through the rows to
                // the wrapper behind them.
                pinned={true}
                onTogglePin={NOOP}
                systemRevealed={false}
                onToggleSystemWorkspace={NOOP}
                onActivateWorkspace={NOOP}
                onToggleSpec={NOOP}
                onAddSpec={NOOP}
                onDestroySpec={NOOP}
                onDisableSpec={NOOP}
                onEnableSpec={NOOP}
                onOpenContextMenu={NOOP}
                onOpenProjectMenu={NOOP}
                onAddWorkspace={NOOP}
                onReorderWorkspaces={NOOP}
                onAddProcess={NOOP}
                onUpdateProcess={NOOP}
                onShowIssueWatch={NOOP}
                lastTerminalType={'regular'}
                onLastTerminalType={NOOP}
                onAgentCreated={NOOP}
            />
        </div>
    );
}
