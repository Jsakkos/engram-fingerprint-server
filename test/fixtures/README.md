# Test fixtures

## `real_fingerprints.json`

Real chromaprint fingerprints for two shows (South Park S1E1–E3, The Expanse
S1E1–E3), used by [`identify_real_fixtures.test.ts`](../identify_real_fixtures.test.ts)
to exercise cross-show / cross-episode discrimination and the `/v1/identify`
confidence floor at realistic scale (~11k–22k hashes per episode — The Expanse
sits in the ~21.8k regime from
[issue #3](https://github.com/Jsakkos/engram-fingerprint-server/issues/3)).

Each episode entry stores `fp_zstd_varint_b64`: base64 of the **engram wire
format** (LEB128 varint of the uint32 hash stream, then zstd level 11) — exactly
what `decodeZstdVarint` (`src/codec.ts`) consumes. The test base64-decodes and
`decodeZstdVarint`s it back to `number[]`.

### Regenerating

Extracted with `fpcalc 1.5.1` (`-raw -length 99999`); episodes whose audio codec
the bundled ffmpeg couldn't decode were first transcoded to mono/11025 WAV with a
newer system ffmpeg. Encoded with Python `zstandard` level 11 to match the server
codec. The one-off builder script is not committed (it hard-codes a local media
library and fpcalc path). To regenerate, point a builder at your own media using
the wire format above; `hash_count` in each entry lets the test self-check the
round-trip.
