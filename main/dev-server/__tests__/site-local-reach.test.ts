import { describe, expect, it } from 'vitest';
import { siteLocalReach } from '../site-manager';

/**
 * The `With curl` line has to EARN its place on the site card.
 *
 * It exists for one reason (genie#195): a CONTAINER site's published port belongs
 * to the sandbox's Caddy, which TLS-terminates and picks the vhost by SNI. A
 * plain-http request to it gets "Client sent an HTTP request to an HTTPS server",
 * and even the https URL needs `--resolve`, because the `.gen` name resolves
 * nowhere on this machine. There, the command is genuinely not reconstructable
 * from the URL, so showing it saves a confusing failure.
 *
 * A HOST-NATIVE site is the opposite case: the dev server holds the port itself
 * and speaks plain http, so the "command" is `curl -s <the URL printed directly
 * above it>`. That is not information, it is the same field twice — and a card
 * that pads itself with a line saying nothing trains people to skim past the
 * lines that do say something.
 */

describe('a host-native site', () => {
    it('offers NO curl command — the URL above it is already dialable', () => {
        const reach = siteLocalReach({ genName: 'docs.gen', port: 58228, sniTls: false });

        expect(reach.localOrigin).toBe('http://127.0.0.1:58228');
        expect(reach.localCurl).toBeUndefined();
    });
});

describe('a container site', () => {
    it('still offers one, because its URL cannot be dialed unaided', () => {
        const reach = siteLocalReach({ genName: 'web.acme.gen', port: 49812, sniTls: true });

        expect(reach.localOrigin).toBe('https://web.acme.gen:49812');
        // -k for Caddy's internal CA, --resolve because the SNI name has to be the
        // `.gen` one for Caddy to route to this vhost at all.
        expect(reach.localCurl).toBe(
            'curl -sk --resolve web.acme.gen:49812:127.0.0.1 https://web.acme.gen:49812/',
        );
    });
});
