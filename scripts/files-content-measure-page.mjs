/** Serialized by the VM CDP harness into the app's page. No transport or native fallback. */
export async function measureFilesPage(input) {
    const bridge = window.genieTest;
    if (!bridge) throw new Error('the visible page bridge window.genieTest is not ready');
    const invoke = () => {
        switch (input.method) {
            case 'open': return bridge.files.open(...input.args);
            case 'readMedia': return bridge.files.readMedia(...input.args);
            case 'lastCommitted': return bridge.files.lastCommitted(...input.args);
            case 'tree': return bridge.files.tree(...input.args);
            case 'children': return bridge.files.children(...input.args);
            case 'gitStatus': return bridge.files.gitStatus(...input.args);
            case 'state': return bridge.files.state(...input.args);
            case 'write': return bridge.files.write(...input.args);
            case 'readBytes': return bridge.files.readBytes(...input.args);
            case 'writeBytes': return bridge.files.writeBytes(...input.args);
            case 'repo': return bridge.repo.call(...input.args);
            default: throw new Error('unknown Files measurement operation');
        }
    };
    let ticks = 0, last = performance.now(), maxGapMs = 0;
    const ticker = setInterval(() => { const at = performance.now(); maxGapMs = Math.max(maxGapMs, at - last); last = at; ticks++; }, 20);
    try {
        // Same clock's live before/after controls keep a quiet timer from masquerading as responsiveness.
        await new Promise(resolve => setTimeout(resolve, 60));
        const beforeTicks = ticks, started = performance.now();
        let completedAt = null, probeAt = null;
        const operation = invoke().then(result => { completedAt = performance.now(); return result; });
        const probe = bridge.workspaces.settings(input.workspaceId ?? 'tynn').then(result => { probeAt = performance.now(); return result; });
        const [value, during] = await Promise.all([operation, probe]);
        const elapsedMs = completedAt - started, duringTicks = ticks - beforeTicks;
        await new Promise(resolve => setTimeout(resolve, 60));
        const text = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : typeof value?.conflict?.onDisk === 'string' ? value.conflict.onDisk : typeof value?.value === 'string' ? value.value : null;
        const encoded = typeof value?.base64 === 'string' ? Uint8Array.from(atob(value.base64), character => character.charCodeAt(0)) : new TextEncoder().encode(text ?? JSON.stringify(value));
        const digest = await crypto.subtle.digest('SHA-256', encoded);
        const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const fixtureCount = Array.isArray(value) ? value.filter(node => /^entry-[0-9]{5}-/.test(node.id)).length : null;
        if (input.expect?.sha256 && sha256 !== input.expect.sha256) throw new Error('Files measurement content hash differs from the fixture');
        if (typeof input.expect?.fixtureCount === 'number' && fixtureCount !== input.expect.fixtureCount) throw new Error('Files measurement omitted fixture paths');
        return {
            ok: value?.ok !== false, bytes: encoded.byteLength, sha256, elapsedMs,
            count: Array.isArray(value) ? value.length : null,
            fixtureCount,
            nativeSha: value?.sha ?? value?.conflict?.sha ?? null,
            error: value?.error ?? value?.reason ?? null,
            ...(input.returnContent === false ? {} : { text, value }),
            heartbeat: { before: beforeTicks, during: duringTicks, after: ticks - beforeTicks - duringTicks, maxGapMs },
            concurrentSettings: { ok: during?.ok === true, completedBeforeContent: probeAt <= completedAt, elapsedMs: probeAt - started },
        };
    } finally { clearInterval(ticker); }
}
