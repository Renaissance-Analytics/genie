/** Serialized into the app page by the VM harness; uses only its real pageBridge. */
export async function measureChatDraftsPage(input) {
    const bridge = window.genieTest;
    if (!bridge?.chatDrafts) throw new Error('the page bridge window.genieTest.chatDrafts is not ready');
    let ticks = 0, last = performance.now(), maxGapMs = 0;
    const ticker = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++; }, 16);
    try {
        await new Promise(resolve => setTimeout(resolve, 60));
        const before = ticks, started = performance.now(); let completedAt, settingsAt;
        const invoke = () => {
            if (input.method === 'readFile') return bridge.chatDrafts.readFile(...input.args);
            if (input.method === 'save') return bridge.chatDrafts.save(...input.args);
            if (input.method === 'load') return bridge.chatDrafts.load(...input.args);
            throw new Error('unknown draft measurement operation');
        };
        const operation = invoke().then(value => { completedAt = performance.now(); return value; });
        const settings = bridge.workspaces.settings(input.workspaceId).then(value => { settingsAt = performance.now(); return value; });
        const [value, concurrent] = await Promise.all([operation, settings]);
        const during = ticks - before;
        await new Promise(resolve => setTimeout(resolve, 60));
        const heartbeat = { before, during, after: ticks - before - during, maxGapMs };
        // Save timing ends at acknowledgement; the independent read-back is verification, outside that row's latency.
        const verifyStarted = performance.now();
        const content = input.method === 'save' ? (await bridge.chatDrafts.load())?.[input.args[0]] : value;
        if (content === null || content === undefined) throw new Error('the measured draft content was not kept or is unavailable');
        const bytes = input.method === 'readFile' ? content : new TextEncoder().encode(JSON.stringify(content));
        if (!(bytes instanceof Uint8Array)) throw new Error('the kept attachment did not return bytes');
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        const count = input.method === 'load' ? Object.keys(content).length : null;
        if (input.expect?.sha256 && input.expect.sha256 !== sha256) throw new Error('draft measurement content hash differs from the fixture');
        if (typeof input.expect?.bytes === 'number' && input.expect.bytes !== bytes.byteLength) throw new Error('draft measurement byte count differs from the fixture');
        if (typeof input.expect?.count === 'number' && input.expect.count !== count) throw new Error('draft measurement omitted entries');
        return { method: input.method, bytes: bytes.byteLength, sha256, count, elapsedMs: completedAt - started, verificationMs: performance.now() - verifyStarted, heartbeat, concurrentSettings: { ok: concurrent?.ok === true, elapsedMs: settingsAt - started, completedBeforeContent: settingsAt <= completedAt } };
    } finally { clearInterval(ticker); }
}
