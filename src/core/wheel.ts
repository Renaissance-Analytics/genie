/**
 * A MOUSE WHEEL OVER A SIDEWAYS ROW (the owner, 2026-10-17: "make the chat tabs row scroll horizontal with the mouse
 * wheel"). A wheel only scrolls up and down, and a row of tabs only scrolls sideways, so the wheel's vertical turn is
 * the row's horizontal move. A trackpad already scrolls sideways on its own: a gesture that carries any horizontal
 * movement is left to the browser, not doubled. Line-mode wheels (Firefox) report lines, not pixels.
 */
export const WHEEL_LINE_PX = 16;

export function horizontalWheel(e: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number }): number {
    if (e.deltaX !== 0 || e.deltaY === 0) return 0;
    return e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
}
