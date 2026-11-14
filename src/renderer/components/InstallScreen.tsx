import type { InstallScreen as InstallScreenModel } from '../../core/install-screen.js';
import { Button } from '@particle-academy/react-fancy';

/**
 * THE RESTART SCREEN (genie#1201; the owner: "the whole Genie UI freezes, turns a pale white … We need a better UX during
 * that time"). Covers the window from the "Restart to install" click until Genie is gone, saying what it waits for —
 * the words come from core/install-screen.ts. While agents finish, the person can choose to proceed immediately.
 */
export function InstallScreen({ screen, onForce }: { screen: InstallScreenModel; onForce?: (() => void) | undefined }) {
    return (
        <div
            data-install-screen
            role="alertdialog"
            aria-live="polite"
            aria-label={screen.title}
            className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-4 bg-[var(--bg-0)] text-center"
        >
            <div aria-hidden className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-1)] border-t-[var(--fg-1)]" />
            <h2 className="text-base font-semibold text-[var(--fg-1)]">{screen.title}</h2>
            <p data-install-screen-detail className="text-[13px] text-[var(--fg-2)]">{screen.detail}</p>
            {screen.forceLabel && onForce ? <Button onClick={onForce}>{screen.forceLabel}</Button> : null}
        </div>
    );
}
