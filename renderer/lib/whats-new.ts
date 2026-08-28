export function shouldShowWhatsNew(
    previouslySeen: string | null | undefined,
    currentVersion: string,
): boolean {
    return !!currentVersion && previouslySeen !== currentVersion;
}
