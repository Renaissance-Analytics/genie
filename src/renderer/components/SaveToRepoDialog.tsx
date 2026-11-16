import type { SaveDialogView } from '../../core/save-dialog-view.js';
import type { SaveChoices, SavePreview, SaveResult } from '../../core/workspace-save.js';

/** Inert stubs (RED): the Save to repo dialog (Tynn #756 UI). */

export interface SaveToRepoViewProps {
    readonly workspaceName: string;
    readonly view: SaveDialogView;
    readonly onChoose: (id: string, side: 'local' | 'incoming') => void;
    readonly onSave: () => void;
    readonly onClose: () => void;
}

export function SaveToRepoView(_props: SaveToRepoViewProps) {
    return null;
}

export function SaveToRepoDialog(_props: {
    readonly workspaceName: string;
    readonly load: () => Promise<SavePreview>;
    readonly save: (choices: SaveChoices) => Promise<SaveResult>;
    readonly onClose: () => void;
}) {
    return null;
}
