import { test, expect } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

test('a managed app backend delivers attributed HTTP mail to an agent inbox', async () => {
    const { app } = await launchGenieE2E();
    try {
        const result = await app.evaluate(() =>
            (globalThis as Record<string, any>).__GENIE_E2E_APPS__.backendInboxDelivery(),
        );
        expect(result.sent.status).toBe(200);
        expect(result.sent.body.result.structuredContent).toMatchObject({ ok: true, delivered: 1 });
        expect(result.received.ok).toBe(true);
        expect(result.received.messages).toHaveLength(1);
        expect(result.received.messages[0]).toMatchObject({
            from: `genie:app:${result.appId}`,
            fromLabel: 'App: Backend Inbox Fixture',
            text: `[Backend Inbox Fixture (a Genie App)] ${result.text}`,
        });
        expect(result.revoked.status).toBe(401);
        expect(result.revoked.body.error).toMatch(/revoked|grant.*changed/i);
        expect(result.afterRevocation.messages).toEqual([]);
    } finally {
        await app.close();
    }
});
