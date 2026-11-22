import type { AlertKind } from '../../core/alerts.js';

// RED STUB (Tynn #1022): the block is not drawn yet.
export function SoundVolume(_props: { values: Readonly<Record<string, boolean | string>> | null; onAction: (action: { kind: 'settings.set'; key: string; value: boolean | string }) => void; onPreview?: ((kind: AlertKind, volume: number) => void) | undefined }) {
    return null;
}
