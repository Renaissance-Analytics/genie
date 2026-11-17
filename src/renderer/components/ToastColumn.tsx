import type { ReactNode } from 'react';

/**
 * THE ONE BOTTOM-LEFT TOAST COLUMN (Tynn #730): the approval stack and Genie's own alert toasts (genie#1211) share it, so
 * they can never overlap. It is placed ONCE - bottom-left of the PAGE COLUMN (the content beside the rail, before the chat
 * dock), a margin from both edges, never wider than the column less its margins (`toastBox`, core/approval-toasts.ts) - and
 * its children only stack in it, in one flex column. Children are listed in priority order and drawn from the corner up:
 * approvals first (nearest the corner), alerts above them. The chat and its input are a column after the page, so nothing
 * here can reach them at any width.
 *
 * The column itself takes no pointer events; each toast does, so the empty space around them still clicks through.
 */
export function ToastColumn({ children }: { children: ReactNode }) {
    return (
        <div
            data-toast-column=""
            className="pointer-events-none absolute bottom-4 left-4 z-30 flex max-h-[calc(100%-2rem)] w-[372px] max-w-[calc(100%-2rem)] flex-col-reverse gap-2 overflow-y-auto"
        >
            {children}
        </div>
    );
}
