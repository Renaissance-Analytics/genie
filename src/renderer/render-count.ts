/**
 * RENDER COUNTS, FOR WHOEVER ASKS (genie#1340). A view calls `countRender('<name>')` once per render; nothing is counted
 * unless `globalThis.__genieRenders` is an object — a test sets it, and the perf harness (`scripts/perf-lag/measure.mjs`)
 * sets it in a test VM's window. Otherwise it is one property read per render.
 *
 * What it is for: a push must cost what it changed. "One agent's update re-renders no other agent's view" and "a
 * keystroke re-renders no thread row" are claims about how often a view draws, and this is how they are counted.
 */
export function countRender(name: string): void {
    const counts = (globalThis as { __genieRenders?: Record<string, number> }).__genieRenders;
    if (counts) counts[name] = (counts[name] ?? 0) + 1;
}
