/** RED CDP seam: real method calls and sampling are implemented only after the assertion RED is measured. */
export function createHeapSampler(_cdp, _now = () => performance.now()) {
    return {
        async start() {},
        async sample() {},
        async finish() { return { heapBeforeBytes: 0, heapAfterGcBytes: 0, gc: false, heapSeries: [] }; },
    };
}
