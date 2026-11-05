/** Serialized into the app's own page bridge by the CI/VM harness. */
export async function measureArtboardPage(input) {
    const bridge = window.genieTest;
    if (!bridge?.artboard) throw new Error('the page ArtBoard bridge window.genieTest.artboard is not ready');
    let ticks = 0, last = performance.now(), maxGapMs = 0;
    const ticker = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++; }, 16);
    try {
        await new Promise(resolve => setTimeout(resolve, 60));
        const before = ticks, started = performance.now(); let completedAt, settingsAt;
        const operation = bridge.artboard.read(input.workspaceId).then(value => { completedAt = performance.now(); return value; });
        const settings = bridge.workspaces.settings(input.workspaceId).then(value => { settingsAt = performance.now(); return value; });
        const [board, concurrent] = await Promise.all([operation, settings]), during = ticks - before;
        await new Promise(resolve => setTimeout(resolve, 60));
        const heartbeat = { before, during, after: ticks - before - during, maxGapMs }, verifyStarted = performance.now();
        if (!board || !Array.isArray(board.posts)) throw new Error('the measured ArtBoard was not available');
        let bytes;
        if (input.postId !== undefined) {
            const post = board.posts.find(post => post.id === input.postId);
            if (!post) throw new Error('the measured ArtBoard artifact was missing');
            if (post.kind === 'html' && typeof post.html === 'string') bytes = new TextEncoder().encode(post.html);
            else if (post.kind === 'image' && typeof post.src === 'string' && post.src.startsWith('data:') && post.src.includes(';base64,')) {
                const binary = atob(post.src.slice(post.src.indexOf(',') + 1)); bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            } else throw new Error('the measured ArtBoard artifact has no content');
        } else bytes = new TextEncoder().encode(JSON.stringify(board));
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (input.expect?.sha256 && input.expect.sha256 !== sha256) throw new Error('ArtBoard measurement content hash differs from the fixture');
        if (typeof input.expect?.bytes === 'number' && input.expect.bytes !== bytes.byteLength) throw new Error('ArtBoard measurement byte count differs from the fixture');
        if (typeof input.expect?.count === 'number' && input.expect.count !== board.posts.length) throw new Error('ArtBoard measurement omitted posts');
        return { bytes: bytes.byteLength, sha256, count: board.posts.length, elapsedMs: completedAt - started, verificationMs: performance.now() - verifyStarted, heartbeat,
            concurrentSettings: { ok: concurrent?.ok === true, elapsedMs: settingsAt - started, completedBeforeContent: settingsAt <= completedAt } };
    } finally { clearInterval(ticker); }
}
