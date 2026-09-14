/**
 * Whether the MCP shuttle keeps running past this quit (genie#346, §3.3).
 *
 * The owner's floor: the shuttle "should never go down or restart unless the user
 * chooses to Quit genie completely, not just the ui". The ceiling is the choice the
 * quit dialog already offers — which terminals to keep running — not a second one.
 * If the owner wants every Quit to stop it, this is the one line to change.
 *
 * A crash, or Genie being killed, never reaches this: the shuttle simply outlives
 * it, which is the case it exists for.
 */
export function shuttleOutlivesQuit(quit: {
    /** Genie is quitting to install an update. */
    forUpdate: boolean;
    /** Genie is quitting to reset the workstation. */
    forReset: boolean;
    /** Terminals still running once this quit has finished tearing down. */
    survivingTerminals: number;
}): boolean {
    if (quit.forReset) return false;
    if (quit.forUpdate) return true;
    return quit.survivingTerminals > 0;
}
