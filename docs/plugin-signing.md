# Signing Genie plugins

Genie trusts an **official** plugin when its `genie-plugin.json` carries a valid
**Ed25519 signature** from a key in Genie's trust root, over an untampered code
bundle. This page covers how official plugins get signed **in CI** and how a
plugin repo wires it up.

- The signing **algorithm** lives in `main/plugins/signing-core.js` (the app's
  `main/plugins/signing.ts` re-exports it; the app's verifier
  `main/plugins/trust.ts` checks against it).
- The **CI signer** is `scripts/sign-plugin.mjs` (dep-free Node — built-in
  `crypto`/`fs` only). Because it imports the app's exact `signing-core` +
  `bundle-files`, a signature it produces **verifies in-app by construction**.
- The **reusable Action** is `.github/actions/sign-genie-plugin/`.

## The trust root

Genie ships one **official** public key — "Genie Official" — embedded in
`BUNDLED_TRUSTED_KEYS` (`main/plugins/trust.ts`):

| field  | value |
| ------ | ----- |
| keyId  | `ed25519-bHc2Rt62EgjmpE5Fd7-QsJeNi36BsAwckJ4bEyx4BCE` |
| label  | Genie Official |
| type   | Ed25519 (SPKI public key) |

The keyId is the fingerprint of the public key (`ed25519-<base64url(sha256(DER
SPKI))>`); Genie derives it from the key itself and never trusts a self-declared
id. The matching **private key never lives in a repo or on a developer laptop** —
it is a GitHub secret used only by CI.

## How signing works

1. **Integrity** — the signer hashes every CODE file in the plugin (recursively,
   excluding `.git/`, `node_modules/`, the manifest itself, and any `*.sig`) into
   `integrity: "sha256-…"`. This is the *same* walk the app runs at install
   (`collectBundleFiles` in `main/plugins/bundle-files.js`), so signer and
   verifier hash the identical bytes.
2. **Signature** — the signer writes `publisher.keyId` (derived from the key) and
   a detached Ed25519 `signature` over the canonical manifest (its own
   `signature` field stripped, `integrity` retained). Signing the manifest
   therefore transitively binds the code hash too.
3. **Verification (in Genie)** — at install/enable Genie recomputes the integrity
   from the on-disk bundle and verifies the signature against the trusted key. A
   tampered code file (integrity mismatch), a tampered manifest (signature fails),
   or a wrong/unknown key all resolve to `untrusted` and are **refused**.

## Owner: add the signing key as an org secret

The private key is provisioned **once** as an **organization secret** so every
official plugin repo can sign without ever storing the key.

1. Generate the production keypair (already done for the official key). To mint a
   fresh one:

   ```bash
   node -e "const {generateSigningKeyPair}=require('./main/plugins/signing-core.js');const k=generateSigningKeyPair();console.log(k.keyId);require('fs').writeFileSync('genie-signing.key',k.privateKeyPem);console.log('public:\n'+require('crypto').createPublicKey(k.privateKeyPem).export({type:'spki',format:'pem'}).toString());"
   ```

   Embed the **public** key in `BUNDLED_TRUSTED_KEYS`; keep the **private** key
   out of the repo.

2. Add the private key as an org secret named **`GENIE_PLUGIN_SIGNING_KEY`**:

   - GitHub → the org → **Settings → Secrets and variables → Actions → New
     organization secret**.
   - Name: `GENIE_PLUGIN_SIGNING_KEY`
   - Value: the full private-key PEM (including the
     `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines).
   - Repository access: scope it to the official plugin repos (recommended:
     "Selected repositories") so only sanctioned repos can sign.

   Delete any local copy of the private key once the secret is set.

## Plugin repo: sign on release

Add a workflow that runs on release (or a manual dispatch) and calls the Action:

```yaml
# .github/workflows/sign.yml
name: Sign plugin
on:
  workflow_dispatch:
  push:
    branches: [release]     # or a release-prep branch

permissions:
  contents: write           # only needed if the Action commits the signed manifest

jobs:
  sign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Renaissance-Analytics/genie/.github/actions/sign-genie-plugin@main
        with:
          signing-key: ${{ secrets.GENIE_PLUGIN_SIGNING_KEY }}
          # Guard: refuse to sign unless the secret is the official key.
          expect-key-id: ed25519-bHc2Rt62EgjmpE5Fd7-QsJeNi36BsAwckJ4bEyx4BCE
          # plugin-dir: .           # where genie-plugin.json lives (default: repo root)
          # commit: 'true'          # commit + push the signed manifest (default)
```

The Action:

- sets up Node, runs `scripts/sign-plugin.mjs` with the key from the env secret
  (never written to disk), and
- with `commit: true` (default) commits + pushes the updated `genie-plugin.json`
  back to the branch. It no-ops on a **detached HEAD** (tag builds) — for a
  tag/release-asset flow set `commit: 'false'` and upload the signed manifest as
  a release asset instead, e.g.:

  ```yaml
      - uses: Renaissance-Analytics/genie/.github/actions/sign-genie-plugin@main
        with:
          signing-key: ${{ secrets.GENIE_PLUGIN_SIGNING_KEY }}
          expect-key-id: ed25519-bHc2Rt62EgjmpE5Fd7-QsJeNi36BsAwckJ4bEyx4BCE
          commit: 'false'
      - run: gh release upload "$GITHUB_REF_NAME" genie-plugin.json --clobber
        env:
          GH_TOKEN: ${{ github.token }}
```

### Action inputs

| input | default | purpose |
| ----- | ------- | ------- |
| `signing-key` | — (required) | Ed25519 private-key PEM. Pass `${{ secrets.GENIE_PLUGIN_SIGNING_KEY }}`. |
| `plugin-dir` | `.` | Directory holding `genie-plugin.json`. |
| `expect-key-id` | `""` | Refuse to sign unless the key derives to this id. Set it to the official id. |
| `publisher-name` | `""` | Set `publisher.name` when the manifest lacks one. |
| `publisher-url` | `""` | Set `publisher.url`. |
| `commit` | `"true"` | Commit + push the signed manifest (needs `contents: write`). |
| `commit-message` | `chore: sign genie-plugin.json` | Commit message. |
| `node-version` | `"20"` | Node used to run the signer. |

## Line endings (important for cross-platform verification)

Integrity is a hash of your plugin's **raw file bytes**, so the signer (Linux CI)
and every user's Genie must see the *same* bytes. Genie clones plugin repos with
`core.autocrlf=false` + `core.eol=lf` so a Windows host doesn't rewrite `LF`→`CRLF`
and break verification — but for defense-in-depth, pin line endings in your plugin
repo too:

```gitattributes
# .gitattributes at the plugin repo root
* text=auto eol=lf
```

Commit your code with `LF` and the signature stays valid on every platform.

## Signing locally (development)

You normally sign in CI, but you can dry-run the signer against a key file:

```bash
GENIE_PLUGIN_SIGNING_KEY="$(cat my-signing.key)" \
  node scripts/sign-plugin.mjs path/to/plugin \
  --expect-key-id ed25519-bHc2Rt62EgjmpE5Fd7-QsJeNi36BsAwckJ4bEyx4BCE
```

For **unofficial / developer** plugins you don't need the official key at all:
sign with your own keypair and add its public key to Genie under **Settings →
Plugins → Developer Mode** (`addUserTrustedKey`), or install unsigned in
Developer Mode (which runs the plugin network-restricted).

## Where official plugin repos live

Official plugins live in their own repos under the org, each with a
`genie-plugin.json` at the repo root (or a subdir passed as `plugin-dir`) and the
`sign.yml` workflow above. A `genie-marketplace.json` repo can INDEX several of
them; the marketplace index is signed the same way (see `evaluateMarketplaceTrust`
in `trust.ts`). **Owner review:** decide the canonical home for official plugin
repos and whether the signing secret is org-wide or scoped to a curated set, then
scope `GENIE_PLUGIN_SIGNING_KEY` accordingly.
