/** Move a native file panel and reflect its location in the route. */
export function moveFilePanel(
    run: () => Promise<void> | undefined,
    moved: () => void,
    _refused: (reason: string) => void,
): void {
    void run();
    moved();
}
