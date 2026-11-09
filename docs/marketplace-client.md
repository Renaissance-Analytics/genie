# Publisher-key registry in genie-host (C3)

The host reads its validated cache before opening plugins, then refreshes keys
in the background. Startup and official plugins do not wait for the network.
The host owns the refresh timer and aborts its request at shutdown. Refresh in
Settings also refreshes the registry and reopens installed packages; it reports
network failures after applying the current cache's freshness and withdrawals.
A window operating without genie-host retains its existing local plugin path.

Keys come from anonymous HTTPS REST at
`https://tynn.ai/api/v1/marketplace/publisher-keys`, never MCP. Requests omit
credentials and refuse redirects. Production uses the host's OS trust and proxy
adapter with TLS verification explicitly enabled. An injected alternate origin
must be HTTPS without credentials, path, query or fragment.

The client checks C1's public identity contract, RFC 8410 Ed25519 SPKI bytes and
`sha256:` fingerprint independently. It follows ULID cursors to completion,
rejecting duplicates, loops and malformed pages. Each page allows 200 keys and
512 KiB; each refresh allows 50 pages and 10,000 keys under a 10 second network
deadline. The HTTPS adapter limits bytes as they arrive, including chunked
responses; parsing applies the same cap. No package is downloaded or executed
by this client, and registry metadata cannot create official plugins.

The cache is versioned, capped at 16 MiB, bound to the origin, validated again
at startup and replaced atomically. Active keys expire after 30 minutes; failed
refreshes never extend this deadline. Partial or invalid snapshots grant and
withdraw nothing. Callers receive frozen key maps; compiled keys take precedence
over registry keys and registry withdrawal never replaces compiled authority.

A complete snapshot removing a previously known key records a withdrawal. Its
installed packages become Refused even with publisher checks off. Withdrawals
survive restart and cache expiry. Old registered tool references consult current
key state before loading code, as well as checking B4's package digest. A signed
tool whose registry authority expired must refresh before running. B5 continues
to own the policy for packages signed by unknown keys and Unverified network
grants. A later complete snapshot may restore a relisted key.

Completed-snapshot withdrawals reduce in-memory authority before a cache write;
a storage failure grants no new keys and never retains known withdrawn authority
in memory. The client also tries to remove an obsolete cache when persistence
fails. If the OS refuses both replacement and removal, durable revocation cannot
be guaranteed across a restart; the refresh reports that storage failure. The
cache contains public keys and identities only, with no tokens or private keys.

The CI tests-first head `9e03d225` proved the missing client and missing HTTPS
body cap RED before implementation. Tests use injected REST responses, actual
B4 package signing and the real B5 plugin host, including withdrawn-key refusal
with checks on/off and stale tool references. All Genie tests run on CI under
the owner's C3 instruction; no test launches the owner's desktop application.

## Publishing a package (C5)

From the Genie source checkout, run:

```sh
npm run publish:plugin -- /path/to/package --key-file /private/publisher.pem --token-file /private/publisher.token
```

Use a local Ed25519 private key in PEM format whose public key is registered
with your verified Tynn publisher. The signed manifest's `publisher.keyId`
must equal that public key's `sha256:` SPKI fingerprint. In Tynn's
**Account → Publishers**, mint a named, expiring publish-only token and save
the one-time value in the token file. Revoke it there when no longer needed.
Alternatively, supply the token in `GENIE_PUBLISH_TOKEN`; an explicit token
file takes precedence. The CLI does not read account sessions, project keys
or Genie pairing credentials. Encrypted private keys requiring an interactive
passphrase are not supported.

Keep credential files outside the package directory. The publisher refuses
credential files within it and snapshots containing the supplied key/token or
PEM private-key material. Never pass secret contents in command-line arguments
or paste them into logs; command runners may echo arguments before the CLI runs.

The command uses B4's existing file reader, limits, digest and signing bytes.
It signs every regular file, including dotfiles, and creates the root detached
signature in the upload snapshot. It replaces an old signature in that snapshot
without writing to your source directory. Links, invalid manifests, mismatched
keys and packages over B4 limits are refused before network upload.

Uploads use stateless HTTPS REST at `/api/v1/marketplace/publish`, with only the
dedicated publisher bearer and an `archive` ZIP. OS/bundled certificate trust and
explicit TLS verification are preserved; cookies and redirects are refused.
The upload deadline is two minutes; confirmations are limited to 64 KiB and must
match the package id, version, digest and key. New versions and identical retries
succeed; a changed immutable version, unregistered/revoked key or unusable token
fails with its HTTP status and guidance. Raw response bodies and crypto/file
exceptions are never printed. A failed confirmation can be retried with the same
unchanged package; Tynn keeps an identical retry idempotent.

For a development registry, explicitly set `--origin https://tynn-c5.gen`.
An origin must use HTTPS without embedded credentials, path, query or fragment.
The opt-in `test/live/publish-plugin.live.ts` fixture refuses production and
checks the actual npm command, retry, registry trust and the Marketplace session's
search/review/consent/install path using a disposable publisher. It requires the
owner-approved isolated Tynn setup and `tynn_test` lock; it never opens Electron
or a browser. UI rendering is covered separately by the existing Marketplace
tests; this Node proof is not a visual check of the tab.
