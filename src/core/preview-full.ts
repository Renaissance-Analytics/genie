import type { KeyPress } from './keys.js';

export type PreviewWindow = 'question' | 'main';

/** STUB (RED): inert. */
export function previewFullKey(_press: KeyPress, _full: boolean): 'restore' | null {
    return null;
}

/** STUB (RED): inert. */
export function previewFullClass(_window: PreviewWindow): string {
    return '';
}
