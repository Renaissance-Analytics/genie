# Release pipeline

Genie ships signed installers for Windows, macOS, and Linux via a
GitHub Actions workflow that builds on a matrix of native runners.
This doc covers what the workflow does, the secrets it expects, and
the one-time setup to obtain those secrets.

## What CI runs

Two workflows live in `.github/workflows/`:

- **`ci.yml`** — runs on every push to `main` and every PR. Typechecks
  both `tsconfig`s, runs Vitest, builds the renderer static export.
  Doesn't build installers; no secrets required.
- **`release.yml`** — runs on every `v*` tag push (and on manual
  dispatch). Builds installers on each of `windows-latest`,
  `macos-latest`, `ubuntu-latest` and publishes them to the GitHub
  Release for the tag. Uses code-signing secrets if they're present.

## Cutting a release

```
# bump version in package.json first
git tag -a v0.7.1 -m "v0.7.1"
git push origin v0.7.1
```

The release workflow picks up the tag, builds all three platforms,
and attaches the installers + `latest.yml` / `latest-mac.yml` to a
new GitHub Release that electron-builder creates automatically
(provider config in `electron-builder.yml`).

## Required secrets

Configure these under repo **Settings → Secrets and variables →
Actions**.

### `GH_TOKEN` (optional)

A personal access token with `repo:write` scope so
`electron-builder` can attach release artifacts. The default
`secrets.GITHUB_TOKEN` works fine for same-repo releases and the
workflow falls back to it automatically.

### Windows code signing — `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`

You need a code-signing certificate from a trusted CA. Standard OV
certs cost ~$80/yr; EV certs that bypass SmartScreen reputation
warnings cost ~$300/yr. Recommended providers: DigiCert, Sectigo,
SSL.com.

After purchase:

1. Export the cert + private key as a `.pfx` (PKCS#12) with a
   strong password.
2. base64-encode the file:
   ```bash
   base64 -i certificate.pfx | tr -d '\n' > cert.b64
   ```
3. Paste the contents of `cert.b64` as the value of
   `WINDOWS_CSC_LINK`. Paste the password as
   `WINDOWS_CSC_KEY_PASSWORD`.

`electron-builder` automatically signs the NSIS installer + the
inner `.exe` when these are set.

### macOS code signing — `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`

You need an Apple Developer Program membership ($99/yr) and a
**Developer ID Application** certificate (downloadable from
developer.apple.com → Certificates → +).

1. In Keychain Access, export the cert + private key as a `.p12`
   with a strong password.
2. base64-encode it (same `base64 -i ... | tr -d '\n'` recipe).
3. Paste into `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`.

### macOS notarisation — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Without notarisation, Gatekeeper refuses to launch the app even when
signed. Required env vars:

- **`APPLE_ID`** — the email you log into Apple Developer with.
- **`APPLE_APP_SPECIFIC_PASSWORD`** — generate one at
  appleid.apple.com → Sign-In and Security → App-Specific Passwords.
- **`APPLE_TEAM_ID`** — find on developer.apple.com → Membership.

`electron-builder` will submit the signed `.dmg` to Apple's
notarisation service, wait for the result, and staple the ticket so
the installer works offline.

## Verifying a signed build

After CI succeeds, download an installer and verify:

**Windows:**
```powershell
Get-AuthenticodeSignature .\Genie-Setup-0.7.1.exe
# Status should be "Valid"
```

**macOS:**
```bash
spctl -a -v --type install Genie-0.7.1.dmg
# Expected: "Genie-0.7.1.dmg: accepted; source=Notarized Developer ID"

codesign --verify --deep --strict --verbose=2 /Applications/Genie.app
# Expected: "satisfies its Designated Requirement"
```

## Falling back to unsigned builds

If you don't have certs yet but want to test the build pipeline,
push a tag without configuring secrets. The workflow still produces
installers — they're just unsigned. Users will see SmartScreen
warnings on Windows and a quarantine prompt on macOS. Useful for
internal dogfooding while procurement is in progress; not for public
release.
