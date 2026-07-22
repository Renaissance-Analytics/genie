import { api } from './genie';
import { SETUP_STATUS_PATH } from './recipes/workstation-setup';

/**
 * Workstation Setup launch decision.
 * ===========================================================================
 *
 * When the owner connects to a workstation (a HOST window), Genie asks the host
 * whether Workstation Setup is still needed and, if so, opens the WizardModal on
 * the `workstationSetupRecipe`. The DECISION is a pure predicate over the host's
 * status signal + whether a wizard is already open — extracted here so it is
 * unit-testable independently of the React launcher (which only does the impure
 * fetch + render). Mirrors genie-cloud's `SetupStatus`.
 */

/** The host's machine-readable setup status (mirror of genie-cloud `SetupStatus`). */
export interface SetupStatusView {
    complete: boolean;
    needed: boolean;
    steps: { agents: boolean; github: boolean };
}

/**
 * Open the wizard only when the host says setup is NEEDED and none is already
 * open. An unknown status (a link blip / an older host without the endpoint) is
 * treated as "don't open" — the owner is never nagged on a transient failure,
 * and a real need re-surfaces on the next connect.
 */
export function shouldOpenWorkstationSetup(
    status: SetupStatusView | null | undefined,
    opts: { alreadyOpen: boolean },
): boolean {
    if (opts.alreadyOpen) return false;
    return status?.needed === true;
}

/**
 * Fetch the host's setup status over the remote bridge. Returns null on any
 * failure (link blip, or a host predating the endpoint), which
 * {@link shouldOpenWorkstationSetup} treats as "don't open". Impure (calls
 * `api()`), so the React launcher composes it with the pure decision above.
 */
export async function fetchSetupStatus(): Promise<SetupStatusView | null> {
    try {
        const res = (await api().remote.request(SETUP_STATUS_PATH)) as { status?: SetupStatusView };
        return res?.status ?? null;
    } catch {
        return null;
    }
}
