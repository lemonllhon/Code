# @lcode/lcode-cua

LCode Computer Use runtime package. The public runtime sends the repository's
14-method Computer Use contract through a newline-JSON broker to an independent
Helper process. The broker authenticates mutations with the Host capability and
generation; missing credentials, invalid responses, unavailable native support,
and denied permissions keep the existing fail-closed result shape.

The Helper uses `@crowecawcaw/xa11y` for real UIA/AX/AT-SPI application trees,
window screenshots, semantic actions, and raw input simulation. Screenshots are
emitted as official CUA frame triples (raster + frame reference + integrity
`_meta`), with the captured application/window binding carried in the frame
reference so later coordinate actions cannot silently retarget after focus
changes. The older `@nut-tree-fork/nut-js` driver remains an internal regression
seam; the product runtime never falls back to it when the Helper is unavailable.

`LCODE_CUA_E2E=1 pnpm --dir packages/lcode-cua e2e:local` checks the direct
driver seam. On Windows, `LCODE_CUA_HELPER_E2E=1 pnpm --dir packages/lcode-cua
e2e:helper` checks the public runtime, broker, real Helper, UIA tree, window
screenshot, session close, and authenticated shutdown without sending input.

See `specs/computer-use-open-replacement.md` for the action surface, the
wire contracts, permission ownership, model compatibility, and packaging
constraints.

macOS distributions may be unsigned. The shared Helper installer defaults to
`signaturePolicy: "optional"`; bundle identity, executable architecture and runtime
resource integrity are still checked. Set `signaturePolicy: "required"` to require
code signature, TeamIdentifier and Gatekeeper verification. Main and Host use the
same installer policy. Unsigned execution does not imply verified signing identity.
The macOS SEA build adds an offline ad-hoc executable seal after injection, as
required for local execution; it uses no developer certificate or notarization.

License: Apache-2.0.
