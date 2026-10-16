# Fonts

Geist and Geist Mono (variable weight, upright and italic) from
https://github.com/vercel/geist-font release **v1.7.2** (`geist-font-v1.7.2.zip`,
sha256 7fc800d2ac6b92844895196e5041aca55d814c15db70c44f79b3b83ab82b04e2), renamed from
`Geist[wght].woff2` etc. because square brackets in an asset filename collide with the bundler's
`[name]` placeholders. Licensed under the SIL Open Font License 1.1 — see OFL.txt.

They ship with the app so the window renders in the design contract's face offline and never
reaches a CDN on boot. `test/fonts.test.ts` checks each declared file exists and is a woff2.
