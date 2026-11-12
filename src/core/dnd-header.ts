/**
 * DO NOT DISTURB, IN THE HEADER (Tynn #655). STUB: the tests come first.
 */
export const DND_SETTING = 'do_not_disturb' as const;

export interface DndHeaderView {
    readonly on: boolean;
    readonly icon: 'bell' | 'bell-off';
    readonly label: string;
    readonly tooltip: string;
}

export function dndHeader(_values: Readonly<Record<string, boolean | string>> | null): DndHeaderView | null {
    return { on: false, icon: 'bell', label: '', tooltip: '' };
}

export function dndToggleAction(_on: boolean): { kind: 'settings.set'; key: string; value: boolean } {
    return { kind: 'settings.set', key: '', value: false };
}
