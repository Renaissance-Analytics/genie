import { Button } from '@particle-academy/react-fancy';

/**
 * RESTART FRESH, ASKED FIRST (Tynn #1084). An agent whose conversation cannot be opened on the active account cannot move to it
 * on its thread; "Restart on <active> now" then starts it there as a NEW conversation. That loses its thread on this account, so
 * it is never one click: this says what happens and waits for Confirm. Used by the agent's header and the Accounts panel.
 */
export function MoveFreshConfirm({ to, onConfirm, onCancel }: { readonly to: string; readonly onConfirm: () => void; readonly onCancel: () => void }) {
    return (
        <div data-move-fresh-confirm="" role="alertdialog" aria-label={`Restart fresh on ${to}`}
            className="flex flex-col gap-1.5 rounded-md border border-[var(--warning)] bg-[var(--warning)]/10 p-2 text-xs text-[var(--fg-1)]">
            <span>{`Restart fresh on ${to}? It starts a new conversation on ${to}, because this conversation can't move there.`}</span>
            <div className="flex gap-1.5">
                <Button type="button" size="xs" data-action="move-fresh-confirm" onClick={onConfirm}>{`Start fresh on ${to}`}</Button>
                <Button type="button" size="xs" variant="ghost" data-action="move-fresh-cancel" onClick={onCancel}>Cancel</Button>
            </div>
        </div>
    );
}
