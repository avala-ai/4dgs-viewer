# 4dgs Viewer

A client-only reference viewer for `.4dgs` scenes, intended for `viewer.4dgs.dev`.

Extracted from `avala-ai/4dgs` PR #167 at `3f4b417`, then hardened in the isolated
`salvage/viewer-local-fixes` worktree. Rendering lives here rather than in the format/SDK
repository, preserving that repository's decoder/renderer boundary.

The app accepts a local file or an HTTP URL. Local files stay in the browser; URL reads go directly
from the browser to the supplied origin using HTTP range requests. There is no backend or telemetry.

## Development

```sh
npm run bootstrap:sdk
npm ci
npm run dev
npm test
```

The bootstrap checks out 4dgs commit
[`5fca754`](https://github.com/avala-ai/4dgs/commit/5fca7545783974ed0b227ed144688926f6976f86),
builds only `@4dgs/core` and `@4dgs/browser`, and writes local package archives under the ignored
`.sdk-packs/` directory. The committed lockfile refers to those archives, so run the bootstrap before
`npm ci` in a fresh checkout. This is the same sequence used by CI and avoids installing npm's
unrelated `0.0.1` name-reservation packages.

The test fixtures are the 4dgs cross-SDK conformance corpus captured with this extraction. Decode
tests exercise both indexed and fallback paths; browser tests run the built production bundle in
Chrome using WebGL2.

## Temporary SDK source bootstrap

This app requires `@4dgs/core` and `@4dgs/browser` 0.5.0. At extraction time those versions were not
yet published because npm trusted publishing for the SDK repository is still awaiting human setup
([4dgs#106](https://github.com/avala-ai/4dgs/issues/106)). Do not downgrade to the `0.0.1`
name-reservation packages. Until 0.5.0 is published, the pinned source bootstrap above makes clean
development and CI installs reproducible without copying SDK source or generated packages into this
repository. Once 0.5.0 is published, the file dependencies and bootstrap can be replaced by registry
dependencies in one lockfile update.

## Known decoder gaps

- Complete keyframe-delta files use the SDK's range-backed indexed decoder. A genuinely truncated
  keyframe-delta prefix still enters one `Uint8Array`, with an explicit 512 MiB viewer ceiling,
  because streamed prefix recovery does not yet accept `IReadable`.
- Unindexed, CRC-rejected, and truncated gaussian-birth decoding uses bounded transport reads, but
  the SDK's `decodeScene` retains every decoded Chunk. It needs an incremental consumer API before
  the viewer can retain only frame-relevant state.
- A gaussian-birth stream without a Chunk Index does not retain each gaussian's originating Chunk
  interval, so the viewer cannot reconstruct the §5.5 interval gate after assembly.

Complete keyframe-delta files are checked through the SDK's indexed decoder so index/Delta Chunk
disagreements refuse. Only an actually truncated prefix uses the streamed recovery interpretation.

These are SDK capabilities, not renderer heuristics, and must be fixed in the TypeScript SDK with
conformance coverage rather than hidden behind a viewer-specific second decoder.
