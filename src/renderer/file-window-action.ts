/** Move a native file panel and reflect its location in the route. */
export function moveFilePanel(
    run: () => Promise<void> | undefined,
    moved: () => void,
    refused: (reason: string) => void,
): void {
    const failed = (error: unknown): void => {
        try { console.error('[files] Could not move the file panel.', error); }
        catch { /* A diagnostic reporter failure must not prevent the refusal. */ }
        try { refused('The file panel could not be moved. Try again.'); }
        catch { /* A reporting failure must not escape this window action. */ }
    };
    try {
        const pending = run();
        if (!pending) { refused('File panels can only be moved from this Genie window.'); return; }
        void pending.then(moved).catch(failed);
    } catch (error) { failed(error); }
}
