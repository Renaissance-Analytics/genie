import { request } from 'node:https';

/** Probe only the VM's loopback front door, with the fixture host's SNI and Host header. */
export function fetchLocalSite(host, ca, port = 443) {
    return new Promise((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/', servername: host, headers: { Host: host }, ca, timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
        req.on('error', (error) => resolve({ status: 0, body: error.message }));
        req.end();
    });
}
