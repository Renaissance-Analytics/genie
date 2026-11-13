/** The owner forgets a pairing, then reads what the host kept. No mutation is replayed. */
export async function forgetPairedHost(
    forget: () => Promise<boolean> | undefined,
    refresh: () => Promise<void>,
    refused: (reason: string) => void,
    onForgot: () => void = () => {},
): Promise<void> {
    try {
        const request = forget();
        if (!request) return;
        const forgot = await request;
        if (forgot) onForgot();
        else refused('This machine’s keychain would not forget that pairing, so it is still kept.');
        await refresh();
    } catch (error) {
        try { console.error('[pairing] Could not finish the pairing update.', error); }
        catch { /* Diagnostic reporting must not reject the action. */ }
        try { refused('Genie could not finish updating the pairing list. Check again after it reconnects.'); }
        catch { /* A refused notification must not escape the owned action. */ }
    }
}
