/**
 * CALL EVERY LISTENER, WHATEVER ONE OF THEM DOES (beta.35; the beta.34 Windows release check lost a terminal's exit).
 * A listener that throws — a push to a window that has just closed — must not stop the listeners after it, and must not
 * escape into whoever is calling: for a terminal, that caller is the engine's final flush during exit, and a throw there
 * is how an exit goes missing (fancy, 2026-10-21, fancy-term-host 0.10.0/0.11.0). Its error is reported, not swallowed.
 */
export function fanOut<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, args: A, what: string): void {
    for (const listener of listeners) {
        try {
            listener(...args);
        } catch (error) {
            console.error(`[genie] a ${what} listener threw (the others still ran):`, error);
        }
    }
}
