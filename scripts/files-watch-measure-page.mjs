/** Serialized into the VM's real page. Uses only its existing pageBridge, never another connection. */
export async function measureFilesWatchPage(input) {
    const bridge = window.genieTest;
    if (!bridge?.files?.subscribe) throw new Error('The genieTest page bridge is required for watch measurement.');
    if (input.action === 'start') {
        const previous = window.__filesWatchRun;
        if (previous) { previous.live = false; for (const off of previous.offs) off(); clearInterval(previous.timer); }
        const state = window.__filesWatchRun = { live: true, views: input.views, offs: [], calls: Array(input.views).fill(0), paths: [], tree: null, ticks: 0, maxGapMs: 0, last: performance.now(), started: performance.now(), callbackAt: null };
        state.timer = setInterval(() => { const now = performance.now(); state.maxGapMs = Math.max(state.maxGapMs, now - state.last); state.last = now; state.ticks++; }, 16);
        state.timer.unref?.();
        for (let i = 0; i < input.views; i++) state.offs.push(bridge.files.subscribe(input.workspaceId, input.git ? { git: true } : {}, event => {
            if (!state.live) return; state.calls[i]++; state.callbackAt = performance.now();
            if (event.paths) state.paths = [...event.paths];
            if (event.git?.tree) state.tree = event.git.tree;
        }));
        state.workspaceId = input.workspaceId;
        return { views: state.views };
    }
    const state = window.__filesWatchRun;
    if (!state) throw new Error('The watch measurement has not started.');
    if (input.action === 'stop') { state.live = false; for (const off of state.offs.splice(0)) off(); clearInterval(state.timer); return { views: 0 }; }
    const text = state.tree === null ? null : JSON.stringify(state.tree);
    const hash = text === null ? null : [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { views: state.views, calls: [...state.calls], paths: [...state.paths], treeCount: state.tree ? Object.keys(state.tree).length : 0, treeSha256: hash,
        ticks: state.ticks, maxGapMs: state.maxGapMs, callbackElapsedMs: state.callbackAt === null ? null : state.callbackAt - state.started,
        rendererHeap: performance.memory?.usedJSHeapSize ?? null, concurrentSettings: await bridge.workspaces.settings(state.workspaceId) };
}
