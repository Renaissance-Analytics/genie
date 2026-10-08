import type { OpenFileDeps } from '../editor/open-file';

type FileOpenRequest = Parameters<OpenFileDeps['sendOpenFile']>[0];

interface PanelWindow {
    id?: number;
    sendOpenFile?: (request: FileOpenRequest) => void;
    focus: () => void;
    close: () => void;
    onClosed: (listener: () => void) => void;
}

export interface PoppedFilePanel {
    workspaceId: string;
    specId: string;
}

export class FilePanelWindows {
    private windows = new Map<string, { specId: string; window: PanelWindow; ready: boolean; pending: FileOpenRequest[] }>();
    private claims = new Map<string, number>();
    private owners = new Map<number, PanelWindow>();

    constructor(private ports: {
        open: (specId: string) => PanelWindow;
        changed: () => void;
    }) {}

    list(): PoppedFilePanel[] {
        return [...this.windows].map(([workspaceId, entry]) => ({ workspaceId, specId: entry.specId }));
    }

    claim(workspaceId: string, specId: string, ownerId: number, owner: PanelWindow): boolean {
        if (this.windows.has(workspaceId)) return false;
        const claimedBy = this.claims.get(workspaceId);
        if (claimedBy !== undefined) return claimedBy === ownerId;
        if (!this.owners.has(ownerId)) {
            this.owners.set(ownerId, owner);
            owner.onClosed(() => {
                this.owners.delete(ownerId);
                for (const [workspace, claimed] of this.claims) {
                    if (claimed === ownerId) this.claims.delete(workspace);
                }
                this.ports.changed();
            });
        }
        this.claims.set(workspaceId, ownerId);
        this.ports.changed();
        return true;
    }

    release(workspaceId: string, ownerId: number): void {
        if (this.claims.get(workspaceId) !== ownerId) return;
        this.claims.delete(workspaceId);
        this.ports.changed();
    }

    pop(workspaceId: string, specId: string, ownerId?: number): void {
        const claimedBy = this.claims.get(workspaceId);
        if (ownerId !== undefined && claimedBy !== undefined && claimedBy !== ownerId) {
            throw new Error('The file panel is being edited in another window.');
        }
        const existing = this.windows.get(workspaceId);
        if (existing) {
            existing.window.focus();
            return;
        }
        const window = this.ports.open(specId);
        this.claims.delete(workspaceId);
        this.windows.set(workspaceId, { specId, window, ready: false, pending: [] });
        window.onClosed(() => {
            this.windows.delete(workspaceId);
            this.ports.changed();
        });
        this.ports.changed();
    }

    focus(workspaceId: string): void {
        const popped = this.windows.get(workspaceId);
        if (popped) popped.window.focus();
        else {
            const owner = this.claims.get(workspaceId);
            if (owner !== undefined) this.owners.get(owner)?.focus();
        }
    }

    bringBack(workspaceId: string): void {
        this.windows.get(workspaceId)?.window.close();
    }

    routeOpenFile(request: FileOpenRequest): boolean {
        const popped = this.windows.get(request.workspaceId);
        if (popped?.window.sendOpenFile) {
            popped.window.focus();
            if (popped.ready) popped.window.sendOpenFile(request);
            else {
                if (popped.pending.length >= 64) throw new Error('Too many pending file-open requests.');
                popped.pending.push(request);
            }
            return true;
        }
        const ownerId = this.claims.get(request.workspaceId);
        const owner = ownerId === undefined ? undefined : this.owners.get(ownerId);
        if (!owner?.sendOpenFile) return false;
        owner.focus();
        owner.sendOpenFile(request);
        return true;
    }

    ready(specId: string, ownerId: number): void {
        for (const popped of this.windows.values()) {
            if (popped.specId !== specId || popped.window.id !== ownerId) continue;
            popped.ready = true;
            for (const request of popped.pending.splice(0)) popped.window.sendOpenFile?.(request);
        }
    }
}
