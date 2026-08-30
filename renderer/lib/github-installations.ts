export type InstallationLoadState<T> =
    | { loaded: true; installations: T[]; error: null }
    | { loaded: false; error: string };

export function isGitHubAuthenticationFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /GitHubAuthError|No GitHub token|GitHub token (?:is )?(?:missing|expired)/i.test(message);
}

export function installationLoadState<T>(input: {
    connected: boolean;
    installations?: T[];
    error?: unknown;
}): InstallationLoadState<T> {
    if (!input.connected) return { loaded: false, error: 'GitHub is not connected.' };
    if (input.error !== undefined) {
        return {
            loaded: false,
            error: input.error instanceof Error ? input.error.message : String(input.error),
        };
    }
    return { loaded: true, installations: input.installations ?? [], error: null };
}
