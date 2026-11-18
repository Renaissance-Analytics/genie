import type { ReactNode } from 'react';
import type { PreviewWindow } from '../../core/preview-full.js';

/** STUB (RED): inert. */
export function PreviewFullButton(_props: { full: boolean; onToggle: () => void }) {
    return null;
}

/** STUB (RED): inert. */
export function PreviewFullFrame({ className, children }: { full: boolean; window: PreviewWindow; className?: string; children: ReactNode }) {
    return <div className={className}>{children}</div>;
}

/** STUB (RED): inert. */
export function usePreviewFull(): { full: boolean; toggle: () => void; restore: () => void } {
    return { full: false, toggle: () => {}, restore: () => {} };
}
