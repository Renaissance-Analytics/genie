import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ request: vi.fn(), agent: vi.fn() }));
vi.mock('node:https', () => ({ request: native.request, Agent: class { constructor(options: unknown) { native.agent(options); } } }));
vi.mock('../src/main/host-https-fetch.js', () => ({ rootsOfThisMachine: () => ['fixture-machine-root'] }));
import { featureDownload, publicDownloadTarget } from '../src/main/feature-download.js';

beforeEach(() => { native.request.mockReset(); native.agent.mockClear(); });
const reply = (status: number, text: string, headers: Record<string, string> = {}) => {
    const body = Readable.from([Buffer.from(text)]);
    return Object.assign(body, { statusCode: status, headers });
};
const install = (answer: (url: URL, options: Record<string, unknown>) => ReturnType<typeof reply> | Error) => {
    native.request.mockImplementation((url: URL, options: Record<string, unknown>, received: (response: unknown) => void) => {
        const result = answer(url, options), request = new EventEmitter();
        return Object.assign(request, { end: () => queueMicrotask(() => { if (result instanceof Error) request.emit('error', result); else received(result); }) });
    });
};

describe('the host installer download adapter (Tynn #720)', () => {
    it('keeps exact bytes, the machine roots, verification and the OS proxy on a cross-origin public redirect', async () => {
        install(url => url.hostname === 'downloads.example.com' ? reply(302, '', { location: 'https://cdn.example.com/file' }) : reply(200, 'fixture\u0000bytes'));
        const routes = vi.fn(() => [{ kind: 'proxy' as const, scheme: 'http' as const, host: 'proxy.example.com', port: 8080 }]);
        const download = featureDownload({ proxyRoutes: routes, env: {} });
        expect(Buffer.from(await (await download('https://downloads.example.com/file')).arrayBuffer())).toEqual(Buffer.from('fixture\u0000bytes'));
        expect(routes).toHaveBeenCalledWith('https://cdn.example.com/file');
        expect(native.agent).toHaveBeenCalledExactlyOnceWith({ ca: ['fixture-machine-root'], rejectUnauthorized: true, proxyEnv: { HTTPS_PROXY: 'http://proxy.example.com:8080' } });
        for (const [, options] of native.request.mock.calls) expect(options).toMatchObject({ method: 'GET', rejectUnauthorized: true, signal: expect.any(AbortSignal) });
        for (const [, options] of native.request.mock.calls) expect(options.headers).toEqual({ 'User-Agent': 'Genie installer', 'Accept-Encoding': 'identity' });
    });
    it.each(['http://example.com/file', 'https://someone:password@example.com/file', 'file:///tmp/file'])('refuses an unsafe download target before opening a connection: %s', async url => {
        expect(() => publicDownloadTarget(url)).toThrow(/HTTPS without URL credentials/);
        await expect(featureDownload({ proxyRoutes: () => [{ kind: 'direct' }], env: {} })(url)).rejects.toThrow(/HTTPS/);
        expect(native.request).not.toHaveBeenCalled();
    });
    it('a redirect never downgrades TLS, and a certificate refusal never tries another OS route', async () => {
        install(() => reply(302, '', { location: 'http://cdn.example.com/file' }));
        const download = featureDownload({ proxyRoutes: () => [{ kind: 'direct' }], env: {} });
        await expect(download('https://downloads.example.com/file')).rejects.toThrow(/HTTPS/);
        expect(native.request).toHaveBeenCalledTimes(1);
        native.request.mockClear();
        install(() => Object.assign(new Error('fixture certificate refused'), { code: 'CERT_HAS_EXPIRED' }));
        await expect(featureDownload({ proxyRoutes: () => [{ kind: 'proxy', scheme: 'http', host: 'proxy.example.com', port: 8080 }, { kind: 'direct' }], env: {} })('https://downloads.example.com/file')).rejects.toThrow(/certificate refused/);
        expect(native.request).toHaveBeenCalledTimes(1);
    });
});
