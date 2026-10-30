import type { ReactNode } from 'react';

/** STUB for the red commit (parity audit #7): no boundary yet — a throw below still takes the whole tree down. */
export function ErrorBoundary({ children }: { surface: string; whole?: boolean; resetKeys?: ReadonlyArray<unknown>; children: ReactNode }) {
    return <>{children}</>;
}
