import type { HeldSend } from '../../core/send-grace.js';

/** Messages held for the undo window (Tynn #745, core/send-grace.ts). */
export function ChatHeldSends(_props: { held: readonly HeldSend[]; now: number; onUndo: (id: string) => void; onSendNow: (id: string) => void }) {
    return null;
}
