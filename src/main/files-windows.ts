/**
 * THE POPPED-OUT PANELS' WINDOWS (§4.3), tracked in main. One per workspace: popping out a panel
 * that is already out re-opens its route (the window layer focuses the existing window) and changes
 * nothing here; a window closing — by the user or by "bring it back" — returns the panel. Every
 * change is pushed to the renderers as the whole list, so a dock can draw the bar or the panel from
 * one fact and never guess.
 */

export interface FilesWindowsDeps {
    openWindow(route: string): void;
    closeWindow(route: string): void;
}

export class FilesWindows {
    readonly #deps: FilesWindowsDeps;
    readonly #open = new Set<string>();
    readonly #listeners = new Set<(list: readonly string[]) => void>();

    constructor(deps: FilesWindowsDeps) {
        this.#deps = deps;
    }

    static route(workspaceId: string): string {
        return `genie://files/${workspaceId}`;
    }

    popOut(workspaceId: string): void {
        const had = this.#open.has(workspaceId);
        this.#deps.openWindow(FilesWindows.route(workspaceId));
        if (had) return;
        this.#open.add(workspaceId);
        this.#emit();
    }

    /** Asks the window layer to close that route; the panel returns when the window's close event arrives. */
    bringBack(workspaceId: string): void {
        if (!this.#open.has(workspaceId)) return;
        this.#deps.closeWindow(FilesWindows.route(workspaceId));
    }

    windowClosed(workspaceId: string): void {
        if (!this.#open.delete(workspaceId)) return;
        this.#emit();
    }

    list(): readonly string[] {
        return [...this.#open];
    }

    onChange(listener: (list: readonly string[]) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #emit(): void {
        const list = this.list();
        for (const l of this.#listeners) l(list);
    }
}
