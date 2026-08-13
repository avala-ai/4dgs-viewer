import React from "react";

import Viewer from "./Viewer/index.jsx";

export default function App() {
  return (
    <>
      <header className="siteHeader">
        <a className="brand" href="https://4dgs.dev/">
          4dgs
        </a>
        <nav aria-label="Primary navigation">
          <a href="https://4dgs.dev/guides/">Guides</a>
          <a href="https://4dgs.dev/spec/">Specification</a>
          <a href="https://github.com/avala-ai/4dgs-viewer">GitHub</a>
        </nav>
      </header>
      <main>
        <h1>4dgs Viewer</h1>
        <p className="lede">
          Drop a <code>.4dgs</code> file, choose one from your device, or paste a URL.
        </p>
        <p className="privacy">
          <strong>Nothing is uploaded.</strong> Local files are sliced and decoded in this tab. A
          remote URL is requested directly by this browser using byte ranges. There is no viewer
          backend and no telemetry.
        </p>
        <Viewer />
        <section>
          <h2>Reference implementation</h2>
          <p>
            This viewer favors a clear, checkable implementation over rendering speed. It composes
            Object Tracks, evaluates spherical harmonics through degree 3, and follows the format’s
            half-open time intervals. Its drawing policy is not part of the 4dgs format.
          </p>
        </section>
        <section>
          <h2>Known SDK limits</h2>
          <p>
            The current TypeScript SDK does not expose a bounded <code>IReadable</code> decoder for
            keyframe-delta data or an incremental unindexed gaussian-birth population. The viewer
            names those limitations instead of claiming those paths are bounded.
          </p>
        </section>
      </main>
    </>
  );
}
