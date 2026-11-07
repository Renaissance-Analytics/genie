/**
 * LOGON (the host split, P6; decision 5 and O4). The entry at the OS is the decision: there at logon means Genie starts.
 *
 *   left running + setting on   start
 *   left running + setting off  start
 *   shut down    + setting on   start
 *   shut down    + setting off  stays down until Genie is opened
 *
 * A host left running comes back with no window, because the person had closed the UI.
 */
export function logonEntry(input: { readonly leftRunning: boolean; readonly setting: boolean; readonly startMinimized: boolean }): { readonly launchAtLogin: boolean; readonly startMinimized: boolean } {
    return { launchAtLogin: input.leftRunning || input.setting, startMinimized: input.leftRunning || input.startMinimized };
}
