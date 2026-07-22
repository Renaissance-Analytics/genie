import { useEffect, useRef, useState } from 'react';
import WizardModal from './WizardModal';
import { workstationSetupRecipe, SETUP_WORKSPACE_ID } from '../../lib/recipes';
import { fetchSetupStatus, shouldOpenWorkstationSetup } from '../../lib/setup-launch';

/**
 * Auto-opens the Workstation Setup WizardModal when the owner connects to a
 * workstation that still needs setup.
 * ===========================================================================
 *
 * Mounted ONLY in a connected HOST window (see master.tsx), so `api()` is the
 * remote bridge and the recipe's embedded terminals spawn on the headless host
 * (bound to the reserved `__genie_setup__` workspace). The DECISION is the pure,
 * unit-tested {@link shouldOpenWorkstationSetup}; this component only does the
 * impure fetch + render, and is idempotent — it checks the host once per mount
 * and never reopens after the owner finishes or dismisses (a real remaining need
 * re-surfaces on the next connect, when the host re-reports `needed`).
 *
 * This replaces the dropped fancy-tui on-host auto-open: the SAME recipe now
 * drives a desktop modal with an embedded remote terminal + a real browser
 * hand-off, instead of a terminal-only TUI.
 */
export default function WorkstationSetupLauncher() {
    const [open, setOpen] = useState(false);
    // One check per mount: once we've decided (opened or not), don't nag again.
    const decidedRef = useRef(false);

    useEffect(() => {
        if (decidedRef.current) return;
        let alive = true;
        void fetchSetupStatus().then((status) => {
            if (!alive || decidedRef.current) return;
            decidedRef.current = true;
            if (shouldOpenWorkstationSetup(status, { alreadyOpen: false })) setOpen(true);
        });
        return () => {
            alive = false;
        };
    }, []);

    if (!open) return null;
    return (
        <WizardModal
            recipe={workstationSetupRecipe}
            workspaceId={SETUP_WORKSPACE_ID}
            onClose={() => setOpen(false)}
        />
    );
}
