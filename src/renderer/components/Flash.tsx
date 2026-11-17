import type { ReactNode } from 'react';

export const FLASH_MS = 2500;

/** RED stub: renders nothing of the note. */
export function Flash({ children }: { note: string | null; children?: ReactNode; attrs?: Record<string, string> }) {
    return <>{children}</>;
}
