/** The owner forgets a pairing, then reads what the host kept. No mutation is replayed. */
export function forgetPairedHost(
    forget: () => Promise<boolean> | undefined,
    refresh: () => Promise<void>,
    refused: (reason: string) => void,
): Promise<void> {
    const request = forget();
    if (!request) return Promise.resolve();
    return request.then((forgot) => {
        if (!forgot) refused('This machine’s keychain would not forget that pairing, so it is still kept.');
        return refresh();
    });
}
