<!-- Generated from src/core/plugin-integrity.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# The package format: genie-package/1

A package's signature covers every file in it. The format is `genie-package/1`. Genie checks it when it loads its plugins and again before each run of a signed package's tool, and the Tynn marketplace checks it when a package is uploaded.

## 1. Which files

Every regular file under the package folder, recursively, dotfiles included. Only `genie-plugin.sig` at the package root is left out. Directories are not listed, so an empty directory changes nothing. A package holding a link or any other entry that is not a regular file is refused.

## 2. Paths

Relative to the package root, `/` between segments, UTF-8, exactly as stored. A segment that is empty, `.` or `..`, or a control character (U+0000 to U+001F, U+007F) in a path, refuses the package.

## 3. Limits

Checked on the files' paths and sizes before any byte is read or hashed; a package past one is refused, the reason saying which. The limits count the signed files only: `genie-plugin.sig` is not counted in the number of files or the total, and is still held to the size a file may be.

- at most 10,000 files;
- at most 200 MB in all (1 MB = 1,048,576 bytes);
- at most 50 MB a file;
- a path of at most 1,024 bytes (UTF-8).

## 4. The listing and the digest

Files are ordered by the UTF-8 bytes of their paths, compared byte by byte. Each gives one line, `sha256sum`'s own format, the last one ending in a newline too:

```
<lowercase hex SHA-256 of the file's bytes><two spaces><path>\n
```

The **digest** is the lowercase hex SHA-256 of the listing's UTF-8 bytes: 64 characters.

## 5. The signature

Ed25519 (RFC 8032, pure) over these ASCII bytes: the format's name, a space, `sha256:`, the digest, a newline.

```
genie-package/1 sha256:<digest>\n
```

`genie-plugin.sig`, at the package root, holds the 64-byte signature in standard base64 with padding. Whitespace around it is ignored.

## 6. The key

An Ed25519 public key in SPKI. Its id is `sha256:` followed by the lowercase hex SHA-256 of the key's whole SPKI DER bytes: 71 characters, the `key_id` of the Tynn marketplace's publisher registry. Genie holds each key under that id, and does not trust a key held under an id that is not its fingerprint.

## 7. The manifest

`genie-plugin.json`, at the package root, is one of the signed files. Its `id` and `version` name the package; `publisher.name` names the publisher; `publisher.keyId` holds the signing key's id (the registry's `key_id`).

## What Genie does

- **Signed by a key Genie holds, and the package as signed:** it loads, labelled with its signer.
- **A file changed, added or removed after signing, or a signature that does not verify:** refused as **tampered**, with publisher checks on or off.
- **Unsigned, or signed by a key Genie does not hold:** refused, unless publisher checks are off; then it runs, labelled unsigned. A package running that way is the person's own work in progress and is not checked again before each run.
