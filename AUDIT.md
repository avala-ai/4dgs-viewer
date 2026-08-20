# Extraction audit

Baseline: `avala-ai/4dgs` PR #167, head `3f4b4175395818772e7c027cbd525542da37e85b`.

The PR was closed because the repository-wide boundary puts rendering strategy, GPU code, sorting,
and shaders outside the format/SDK repository. This directory is the minimal standalone extraction
for `avala-ai/4dgs-viewer`; it intentionally does not include Docusaurus, 4dgs documentation, or the
original repository's website workflow.

## Runtime files

- `index.html`, `vite.config.js`
- `src/main.jsx`, `src/App.jsx`, `src/global.css`
- `src/Viewer/{index,openScene,keyframeDelta,framing,camera,renderer}.js[x]`
- `src/Viewer/styles.module.css`

Runtime dependencies are React, React DOM, `@4dgs/core`, and `@4dgs/browser`. Vite and its React
plugin are build-only dependencies. No server package, analytics package, or third-party runtime
script is required.

Until 4dgs issue #106 publishes the 0.5.0 SDK packages, `scripts/bootstrap-sdk.mjs` checks out the
exact 4dgs commit `5fca7545783974ed0b227ed144688926f6976f86`, builds the core and browser workspaces,
and creates ignored local package archives. The application lockfile installs those archives. No SDK
source or build output is vendored in this repository.

## Review findings audited at the baseline

The PR's GitHub review threads were still marked unresolved, so each relevant behavior was checked
against the exact head rather than treating thread state as code state.

- **Object Tracks — real defect, fixed here.** Both gaussian-birth paths returned
  `GaussianSet.stateAt`, leaving tracked objects at rest. Indexed reads now lazily fetch
  `readObjects()` once; both paths use `stateAtWithObjects` before producing a frame. Four tracked
  corpus variants are compared with committed canonical states on both paths.
- **Decode failure during WebGL restore — already fixed at the baseline, now pinned.** Renderer
  construction is caught separately from the asynchronous `frameAt` call. A real-Chrome test makes a
  range request fail only during restoration and verifies the error stays a file/transport error,
  controls for opening a replacement remain enabled, and only the failed scene is retired.
- **Renderer reacquisition after asynchronous framing — already fixed at the baseline, now pinned.**
  `frameCamera` receives a renderer getter and acquires it after `frameAt(0)` settles. A unit test
  replaces the renderer while the promise is pending and proves only the replacement receives the
  frame.
- **Sparse scene framing — already fixed at the baseline, now pinned.** When the landing instant and
  fixed probes are empty, framing falls back to the Header AABB. A test uses a non-origin AABB and
  an empty frame at every probe. A companion test proves a nonempty landing frame triggers no later
  range reads.
- **Complete keyframe index disagreement — real defect, fixed here.** A complete keyframe-delta
  resource now uses `KeyframeDeltaIndexedDecoder`, which checks duplicated index/Delta Chunk fields
  when their chain is selected. Only an actually truncated prefix uses streamed recovery. The
  regression mutates one index depth while leaving the Delta Chunk intact and expects a named
  refusal from that seek.
- **Renderer in the format repository — real architecture defect, fixed by this extraction.** The
  rasterizer, shaders, camera, renderer tests, and renderer-specific prose live in this standalone
  tree rather than in `avala-ai/4dgs`.

## SDK blockers that remain explicit

These cannot be repaired honestly inside a viewer without implementing a second decoder:

- `KeyframeDeltaIndexedDecoder` makes complete keyframe-delta seeks range-backed and bounded. A
  genuinely truncated prefix has no index and `decodeKeyframeDeltaStreamed` still accepts
  `Uint8Array`, not `IReadable`, so recovery retains one contiguous prefix allocation under the
  viewer's explicit 512 MiB ceiling.
- `decodeScene(IReadable)` transports bytes in bounded blocks but retains all decoded Chunks before
  assembling the population. An unindexed, CRC-rejected, or truncated gaussian-birth file is
  therefore not bounded independently of file size.
- Once `decodeScene` assembles an unindexed scene, each gaussian's originating Chunk interval is
  gone. The viewer cannot apply the §5.5 chunk-interval visibility gate without an SDK API that
  preserves or incrementally consumes that association.

The viewer uses a clearly named `ViewerLimitError` for its keyframe-delta ceiling and documents the
unindexed limitation. Those diagnostics make the current capability honest; they do not close the
SDK work.

## Verification

- Production Vite build: green, about 324 KiB JavaScript / 103 KiB gzip with source map.
- Decode suite: 83 tests green across 60 captured conformance files, including invalid refusals,
  object composition, both gaussian-birth paths, range-backed complete keyframe-delta seeks, and
  streamed prefix recovery.
- Browser suite: 10 tests green in headless Chrome/WebGL2, including rendering, context loss,
  restoration, range failure, stale opens, canvas clearing, replay, and texture ceilings.

## Publication

This audit now lives with the extracted application in `avala-ai/4dgs-viewer`. `public/CNAME`
declares the intended `viewer.4dgs.dev` hostname and the Pages workflow deploys `dist/` from `main`.
DNS and Pages activation are intentionally separate release operations.

4dgs issue #106 remains follow-up work, but it no longer prevents clean builds or CI: npm currently
exposes only the `0.0.1` name-reservation packages, while the source bootstrap supplies the exact
0.5.0 SDK revision audited here. When 0.5.0 is published, remove that temporary bootstrap and point
the two dependencies at the registry release.
