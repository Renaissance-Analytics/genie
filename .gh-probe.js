const { app, net, safeStorage } = require('electron');
app.whenReady().then(async () => {
    const CLIENT = 'Ov23liKwoD8eBnzFWN4x';
    console.log('[probe] safeStorage.isEncryptionAvailable():', (() => { try { return safeStorage.isEncryptionAvailable(); } catch(e) { return 'THREW: '+e.message; }})());
    try {
        const params = new URLSearchParams({ client_id: CLIENT, scope: 'repo workflow read:org' });
        const res = await net.fetch('https://github.com/login/device/code', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        console.log('[probe] device/code status:', res.status, 'ok:', res.ok);
        const j = await res.json();
        console.log('[probe] device/code body:', JSON.stringify(j));
        // one poll iteration
        const p2 = new URLSearchParams({ client_id: CLIENT, device_code: j.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        const r2 = await net.fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: p2.toString(),
        });
        console.log('[probe] token poll status:', r2.status, 'ok:', r2.ok);
        console.log('[probe] token poll body:', JSON.stringify(await r2.json()));
    } catch (e) {
        console.log('[probe] THREW:', e && e.stack || e);
    }
    app.quit();
});
