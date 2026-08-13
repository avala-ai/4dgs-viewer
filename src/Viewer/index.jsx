/**
 * The viewer: a drop target, a canvas, a transport control and a refusal panel.
 *
 * The file never leaves the page. `BlobReadable` slices a local `File`; `HttpRangeReadable`
 * range-reads a URL the visitor pastes. Neither one posts anything anywhere, and there is
 * no server side to this page to post it to.
 */

import { BlobReadable, HttpRangeReadable } from "@4dgs/browser";
import {
  FourdgsError,
  MalformedFile,
  TruncatedFile,
  UnsupportedCodec,
  UnsupportedVersion,
} from "@4dgs/core";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { OrbitCamera } from "./camera.js";
import { frameCamera, lastInstant } from "./framing.js";
import {
  ViewerLimitError,
  effectiveCutoff,
  frameAtWithin,
  openScene,
} from "./openScene.js";
import { RendererCapabilityError, SplatRenderer } from "./renderer.js";
import styles from "./styles.module.css";

/** How often the readouts under the canvas are allowed to re-render, in milliseconds. */
const READOUT_INTERVAL = 100;

class ViewerCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ViewerCapabilityError";
  }
}

export default function Viewer() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  /** Everything the animation loop reads and writes without re-rendering React. */
  const playbackRef = useRef({ playable: null, time: 0, playing: false, loop: true, serial: 0 });
  const dragRef = useRef(null);
  /** True only between pointer-down and pointer-up on the scrubber. */
  const draggingScrubRef = useRef(false);
  /** Readout time visible when the most recent keyboard scrub was issued. */
  const keyboardScrubReadoutRef = useRef(null);
  /**
   * Why this browser cannot draw anything, if it cannot.
   *
   * Covers both a browser with no WebGL2 and a context temporarily lost after setup. It is
   * held apart from the per-file refusal so that opening a file cannot clear it, and read
   * through a ref as well as through state because `open` is created once and must see it.
   */
  const setupFailureRef = useRef(null);
  /** The file or range refusal hidden temporarily while WebGL reports a capability error. */
  const fileFailureRef = useRef(null);
  /** The last open attempted during a recoverable context loss. */
  const pendingOpenRef = useRef(null);
  /** Revoke the render loop's current frame request after an explicit seek. */
  const frameRequestRef = useRef(() => {});

  const [source, setSource] = useState(null);
  const [scene, setScene] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [upAxis, setUpAxis] = useState("y");
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  /**
   * Set when an instant refuses to decode, which retires the file.
   *
   * The scene's facts stay on the page — they are still true of the file, and they are half
   * of the diagnosis next to the refusal — but nothing is left to play, so the transport
   * says so by being disabled rather than by accepting clicks and ignoring them.
   */
  const [decodeFailed, setDecodeFailed] = useState(false);
  /** True while WebGL2 is unavailable, including while a lost context is rebuilding. */
  const [setupFailed, setSetupFailed] = useState(false);
  /** Non-null while the visitor is dragging the scrubber, so the readout cannot fight it. */
  const [scrub, setScrub] = useState(null);
  const [readout, setReadout] = useState({ time: 0, count: 0, intervals: [], transfer: null });

  // --- the render loop -----------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    let renderer;
    try {
      renderer = new SplatRenderer(canvas);
    } catch (failure) {
      // No context, so no loop, no renderer and no camera. Nothing below this line will
      // ever run for this page, which is why the failure has to outlive any file the
      // visitor opens next rather than being cleared by the attempt.
      setupFailureRef.current = failure;
      setSetupFailed(true);
      setError(failure);
      return undefined;
    }
    rendererRef.current = renderer;
    cameraRef.current = new OrbitCamera();
    const wheel = (event) => {
      // This must be a non-passive native listener. React delegates wheel events through
      // a passive root listener, where preventDefault cannot keep the page from scrolling.
      event.preventDefault();
      const camera = cameraRef.current;
      if (camera !== null) camera.dolly(Math.exp(event.deltaY * 0.001));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });

    let running = true;
    let contextIsLost = false;
    let previous = performance.now();
    let lastReadout = 0;
    /**
     * The current frame request, if any. Both parts of its identity matter: `serial`
     * changes when the visitor opens another resource, while `generation` changes when
     * WebGL loses every resource belonging to the renderer a request was started for.
     *
     * The token is replaced, rather than shared as a boolean, so an obsolete request may
     * remain unresolved forever without blocking a newer file or restored renderer. It
     * also means a late obsolete settlement cannot clear the newer request's guard.
     */
    let frameGeneration = 0;
    let pendingFrame = null;
    const supersededFrames = new Set();

    const invalidateFrame = () => {
      frameGeneration += 1;
      pendingFrame = null;
    };

    const beginFrame = (playback, playable, wanted, targetRenderer) => {
      const token = {
        serial: playback.serial,
        generation: frameGeneration,
        playable,
        wanted,
        renderer: targetRenderer,
      };
      pendingFrame = token;
      return token;
    };
    const releaseFrame = (token) => {
      supersededFrames.delete(token);
      if (pendingFrame === token) pendingFrame = null;
    };
    const supersedeFrame = () => {
      // IReadable has no cancellation contract. Permit one replacement request for
      // responsiveness, then coalesce later scrub changes behind it until the abandoned
      // wrapper settles or times out. This caps transport operations at one active plus
      // one superseded however many change events a pointer drag produces.
      if (pendingFrame === null || supersededFrames.size > 0) return;
      supersededFrames.add(pendingFrame);
      frameGeneration += 1;
      pendingFrame = null;
    };
    frameRequestRef.current = supersedeFrame;
    const frameIsCurrent = (token) => {
      const playback = playbackRef.current;
      return (
        running &&
        !contextIsLost &&
        token.generation === frameGeneration &&
        playback.serial === token.serial &&
        playback.playable === token.playable &&
        renderer === token.renderer
      );
    };

    const contextLost = (event) => {
      // Prevent the default so the platform is allowed to restore the context. Until then,
      // stop the transport and say why the canvas is blank instead of advancing beside it.
      event.preventDefault();
      contextIsLost = true;
      const failure = new ViewerCapabilityError(
        "the WebGL2 context was lost; rendering is paused while the browser restores it",
      );
      setupFailureRef.current = failure;
      const playback = playbackRef.current;
      playback.playing = false;
      playback.rendered = undefined;
      // A read started for the lost renderer no longer owns the pending slot. It may
      // never settle, and even if it does its generation must keep it off the new GPU.
      invalidateFrame();
      renderer.clear();
      setPlaying(false);
      setSetupFailed(true);
      setError(failure);
      // Some headless and resource-constrained browsers do not initiate restoration on
      // their own. Leave the diagnosis visible first, then ask the WebGL extension to
      // restore; the restored handler recreates every resource rather than reusing any.
      const lostRenderer = renderer;
      setTimeout(() => {
        if (running && contextIsLost && renderer === lostRenderer) {
          lostRenderer.requestContextRestore();
        }
      }, 500);
    };
    const contextRestored = async () => {
      if (!running) return;
      try {
        renderer.dispose();
        renderer = new SplatRenderer(canvas);
        rendererRef.current = renderer;
        contextIsLost = false;
        setupFailureRef.current = null;
        setSetupFailed(false);
        setError(fileFailureRef.current);
      } catch (failure) {
        const wrapped = new ViewerCapabilityError(
          `the WebGL2 context was restored but the renderer could not be rebuilt: ${failure.message}`,
        );
        setupFailureRef.current = wrapped;
        setSetupFailed(true);
        setError(wrapped);
        return;
      }

      const pendingOpen = pendingOpenRef.current;
      pendingOpenRef.current = null;
      if (pendingOpen !== null) {
        open(pendingOpen.readable, pendingOpen.label);
        return;
      }

      // GPU resources do not survive a restored context. Recreate the frame at the
      // current instant from decoded state; a decode/range failure is a file or transport
      // diagnosis, not evidence that rebuilding WebGL failed.
      const playback = playbackRef.current;
      const playable = playback.playable;
      if (playable !== null) {
        const wanted = playback.time;
        const targetRenderer = renderer;
        const token = beginFrame(playback, playable, wanted, targetRenderer);
        try {
          const frame = await frameAtWithin(playable, wanted);
          releaseFrame(token);
          const current = playbackRef.current;
          // The instant is part of the result's identity. If the visitor sought while
          // this range read was pending, leave `rendered` invalid so the loop requests
          // that newer instant instead of labelling this older frame with the new time.
          if (!frameIsCurrent(token) || current.time !== wanted) return;
          targetRenderer.setFrame(frame);
          current.rendered = wanted;
        } catch (failure) {
          releaseFrame(token);
          const current = playbackRef.current;
          if (!frameIsCurrent(token) || current.time !== wanted) return;
          current.playable = null;
          targetRenderer.clear();
          setPlaying(false);
          setDecodeFailed(true);
          fileFailureRef.current = failure;
          setError(failure);
        }
      }
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);

    const tick = (now) => {
      if (!running) return;
      if (contextIsLost) {
        requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min((now - previous) / 1000, 0.25);
      previous = now;
      const playback = playbackRef.current;
      const playable = playback.playable;

      if (playable !== null) {
        // The clock describes the frame on screen. Pause it while that frame is being
        // fetched rather than letting a slow range leave canvas and readouts seconds apart.
        // A never-settling request also keeps its one authoritative timeout: it cannot be
        // invalidated by loop wrap and revisited once per iteration.
        const pendingCurrent =
          pendingFrame !== null &&
          pendingFrame.serial === playback.serial &&
          pendingFrame.generation === frameGeneration;
        if (!pendingCurrent && playback.playing && playable.duration > 0) {
          playback.time += dt;
          if (playback.time >= playable.duration) {
            // The timeline is the half-open [0, duration): the end is never a valid instant.
            if (playback.loop) {
              playback.time = 0;
            } else {
              playback.time = lastInstant(playable.duration);
              playback.playing = false;
              setPlaying(false);
            }
          }
        }
        // One instant in flight at a time for the current open and renderer generation.
        // A request owned by an older open or a lost context does not occupy this slot.
        if (!pendingCurrent && playback.rendered !== playback.time) {
          const wanted = playback.time;
          const targetRenderer = renderer;
          const token = beginFrame(playback, playable, wanted, targetRenderer);
          frameAtWithin(playable, wanted)
            .then((frame) => {
              releaseFrame(token);
              const current = playbackRef.current;
              if (!frameIsCurrent(token) || current.time !== wanted) return;
              current.rendered = wanted;
              targetRenderer.setFrame(frame);
            })
            .catch((failure) => {
              releaseFrame(token);
              const current = playbackRef.current;
              if (!frameIsCurrent(token) || current.time !== wanted) return;
              current.playable = null;
              current.playing = false;
              targetRenderer.clear();
              setPlaying(false);
              setDecodeFailed(true);
              fileFailureRef.current = failure;
              setError(failure);
            });
        }
      }

      renderer.draw(cameraRef.current);

      if (now - lastReadout > READOUT_INTERVAL) {
        lastReadout = now;
        setReadout({
          time: playback.time,
          count: renderer.count,
          intervals: playable === null ? [] : playable.intervalsAt(playback.time),
          transfer: playable === null ? null : playable.transfer(),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    return () => {
      running = false;
      invalidateFrame();
      frameRequestRef.current = () => {};
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (cameraRef.current !== null) {
      cameraRef.current.upAxis = upAxis;
      cameraRef.current.version += 1;
    }
  }, [upAxis]);

  // --- opening a file ------------------------------------------------------

  const open = useCallback(async (readable, label) => {
    // Nothing to open a file into. Restate why rather than replacing it with a refusal
    // about the file, which is not the thing that is wrong.
    if (setupFailureRef.current !== null) {
      if (setupFailureRef.current instanceof ViewerCapabilityError) {
        // A context restoration is already in flight. Keep only the most recent choice;
        // once GPU resources have been rebuilt it is opened through the ordinary serial
        // path, so a startup loss cannot silently eat the visitor's first file.
        pendingOpenRef.current = { readable, label };
      }
      setError(setupFailureRef.current);
      return;
    }
    pendingOpenRef.current = null;
    const playback = playbackRef.current;
    // A URL over a slow link and a large local file both take long enough that a visitor
    // can start a second open before the first returns. Every effect below is guarded by
    // the serial this call started under, so the file that finishes last does not win: the
    // one the page says it is showing does, and an older refusal never replaces a newer
    // one.
    playback.serial += 1;
    const serial = playback.serial;
    const current = () => playbackRef.current.serial === serial;
    playback.playable = null;
    playback.playing = false;
    playback.time = 0;
    playback.rendered = undefined;
    fileFailureRef.current = null;
    setPlaying(false);
    setScene(null);
    setError(null);
    setDecodeFailed(false);
    setSource(label);
    setBusy(true);
    // The canvas belongs to the file the page says it is showing. Leaving the previous
    // scene drawn under a new source label — or under the new file's refusal — invites the
    // reading that some of the new file came through, which is exactly false.
    rendererRef.current?.clear();
    try {
      const playable = await openScene(readable);
      if (!current()) return;
      // Framing also probes a handful of instants. One that will not decode is worth
      // saying now rather than three seconds into playback, so its refusal joins the notes.
      playable.notes.push(
        ...(await frameCamera(
          playable,
          () => rendererRef.current,
          cameraRef.current,
          current,
          refusalName,
        )),
      );
      if (!current()) return;
      playback.playable = playable;
      playback.time = 0;
      playback.rendered = 0;
      setScene(playable);
    } catch (failure) {
      if (current()) {
        fileFailureRef.current = failure;
        // A file or transport failure can finish after context loss. Retain it so WebGL
        // restoration can reveal the file's answer, but until then the blank, disabled
        // viewer is caused by the renderer capability failure and must continue to say so.
        setError(setupFailureRef.current ?? failure);
      }
    } finally {
      if (current()) setBusy(false);
    }
  }, []);

  const openFile = useCallback(
    (file) => {
      if (file === undefined || file === null) return;
      open(new BlobReadable(file), `${file.name} — ${formatBytes(file.size)}, read in this page`);
    },
    [open],
  );

  const openUrl = useCallback(() => {
    const trimmed = url.trim();
    if (trimmed === "") return;
    open(new HttpRangeReadable(trimmed), `${trimmed} — read by byte range from your browser`);
  }, [open, url]);

  // --- pointer camera ------------------------------------------------------

  const onPointerDown = useCallback((event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode: event.shiftKey || event.button === 2 ? "pan" : "orbit",
      x: event.clientX,
      y: event.clientY,
    };
  }, []);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    const camera = cameraRef.current;
    if (drag === null || camera === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - drag.x) / rect.width;
    const dy = (event.clientY - drag.y) / rect.height;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.mode === "pan") camera.pan(dx, dy);
    else camera.orbit(dx * Math.PI * 2, dy * Math.PI);
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // --- transport -----------------------------------------------------------

  const seek = useCallback((value) => {
    const playback = playbackRef.current;
    if (playback.playable === null) return;
    const wanted = Math.max(0, Math.min(value, lastInstant(playback.playable.duration)));
    if (wanted === playback.time) return;
    // A range read may never settle. Revoke its pending slot and publication rights so
    // this explicit seek can start independently and a late older result stays stale.
    frameRequestRef.current();
    playback.time = wanted;
  }, []);

  const togglePlay = useCallback(() => {
    const playback = playbackRef.current;
    if (playback.playable === null) return;
    // A run that ended without looping left the clock on the last instant the timeline
    // contains. Starting from there would reach the duration on the first tick and stop
    // again, so Play from the end means play it again rather than nothing at all.
    if (!playback.playing && playback.time >= lastInstant(playback.playable.duration)) {
      // A URL range for that final instant may never settle. Replaying is a discontinuous
      // seek just like moving the scrubber, so it must release that request's pending slot.
      frameRequestRef.current();
      playback.time = 0;
    }
    playback.playing = !playback.playing;
    setPlaying(playback.playing);
  }, []);

  useEffect(() => {
    playbackRef.current.loop = loop;
  }, [loop]);

  useEffect(() => {
    if (
      !draggingScrubRef.current &&
      scrub !== null &&
      keyboardScrubReadoutRef.current !== null &&
      readout.time !== keyboardScrubReadoutRef.current
    ) {
      keyboardScrubReadoutRef.current = null;
      setScrub(null);
    }
  }, [readout.time, scrub]);

  // --- markup --------------------------------------------------------------

  const duration = scene === null ? 0 : scene.duration;
  const playableNow = scene !== null && duration > 0 && !decodeFailed && !setupFailed;

  return (
    <div className={styles.viewer}>
      <div
        className={dragging ? `${styles.stage} ${styles.stageDragging}` : styles.stage}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          openFile(event.dataTransfer.files[0]);
        }}
      >
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
        />
        {scene === null && error === null && (
          <div className={styles.placeholder}>
            <p className={styles.placeholderTitle}>Drop a .4dgs file here</p>
            <p>
              {busy
                ? "Decoding…"
                : "Or use the file picker below. The file is decoded in this page and is not uploaded."}
            </p>
          </div>
        )}
      </div>

      <div className={styles.transport}>
        <button
          type="button"
          className="button button--secondary button--sm"
          onClick={togglePlay}
          disabled={!playableNow}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          className={styles.scrub}
          type="range"
          min={0}
          max={duration > 0 ? duration : 1}
          step={duration > 0 ? duration / 2000 : 0.001}
          value={scrub ?? readout.time}
          disabled={!playableNow}
          // Pointer drags retain their override until release. Keyboard changes retain it
          // until the throttled readout advances, so repeated arrow events accumulate from
          // the controlled value instead of React restoring the same stale readout value.
          onPointerDown={() => {
            draggingScrubRef.current = true;
            keyboardScrubReadoutRef.current = null;
          }}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (!draggingScrubRef.current) {
              keyboardScrubReadoutRef.current = readout.time;
            }
            setScrub(value);
            seek(value);
          }}
          onPointerUp={() => {
            draggingScrubRef.current = false;
            keyboardScrubReadoutRef.current = null;
            setScrub(null);
          }}
          onPointerCancel={() => {
            draggingScrubRef.current = false;
            keyboardScrubReadoutRef.current = null;
            setScrub(null);
          }}
          onBlur={() => {
            draggingScrubRef.current = false;
            keyboardScrubReadoutRef.current = null;
            setScrub(null);
          }}
          aria-label="Scene time"
        />
        <span className={styles.clock}>
          {readout.time.toFixed(3)} / {duration.toFixed(3)} s
        </span>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={loop}
            onChange={(event) => setLoop(event.target.checked)}
          />{" "}
          Loop
        </label>
        <label className={styles.toggle}>
          Up axis{" "}
          <select value={upAxis} onChange={(event) => setUpAxis(event.target.value)}>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
        </label>
      </div>

      <div className={styles.controls}>
        <label className={styles.file}>
          <input
            type="file"
            accept=".4dgs,application/octet-stream"
            disabled={setupFailed}
            onChange={(event) => {
              const file = event.target.files[0];
              // Browsers suppress a second change event for the same selected path unless
              // the control is reset after each attempt, including refused files.
              event.target.value = "";
              openFile(file);
            }}
          />
        </label>
        <div className={styles.urlRow}>
          <input
            className={styles.url}
            type="url"
            placeholder="…or a URL to a .4dgs, read by byte range"
            value={url}
            disabled={setupFailed}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") openUrl();
            }}
          />
          <button
            type="button"
            className="button button--secondary button--sm"
            onClick={openUrl}
            disabled={setupFailed || url.trim() === ""}
          >
            Open URL
          </button>
        </div>
      </div>

      {source !== null && <p className={styles.source}>{source}</p>}

      {error !== null && <Refusal error={error} />}
      {scene !== null && <Facts scene={scene} readout={readout} />}
    </div>
  );
}

/**
 * The decoder's refusal, printed as it came.
 *
 * `@4dgs/core` names the byte, the record, the value and what was expected, and it
 * distinguishes a malformed file from a legal one this build cannot read. Restating any of
 * that as "could not open this file" would waste the one moment the page had a broken file
 * in hand.
 */
/**
 * Which refusal this is, by type rather than by `error.name`.
 *
 * The site is minified, and a minifier renames classes — `FourdgsError` sets its `name`
 * from `new.target.name`, which in a production bundle is a single letter. The
 * distinction between "your file is broken" and "this build cannot read your file" is
 * worth more than that, so it is recovered from the prototype chain, which survives.
 */
const REFUSAL_NAMES = [
  [ViewerLimitError, "ViewerLimitError"],
  [RendererCapabilityError, "RendererCapabilityError"],
  [ViewerCapabilityError, "ViewerCapabilityError"],
  [MalformedFile, "MalformedFile"],
  [TruncatedFile, "TruncatedFile"],
  [UnsupportedCodec, "UnsupportedCodec"],
  [UnsupportedVersion, "UnsupportedVersion"],
  [FourdgsError, "FourdgsError"],
];

function refusalName(error) {
  for (const [type, name] of REFUSAL_NAMES) if (error instanceof type) return name;
  return error?.name ?? "Error";
}

function Refusal({ error }) {
  return (
    <div className={styles.refusal}>
      <h3 className={styles.refusalTitle}>{refusalName(error)}</h3>
      <pre className={styles.refusalBody}>{error.message}</pre>
      <p className={styles.refusalNote}>
        Printed exactly as the reader raised it. <code>UnsupportedCodec</code> and{" "}
        <code>UnsupportedVersion</code> mean the file may be perfectly conforming and this build
        cannot read part of it; <code>MalformedFile</code> means the bytes are wrong;{" "}
        <code>TruncatedFile</code> means they ran out; viewer capability and limit errors mean the
        file may be valid but this page cannot draw it safely.
      </p>
    </div>
  );
}

function Facts({ scene, readout }) {
  const { header } = scene;
  const rows = [
    ["Temporal model", header.temporalModel],
    ["Read path", READ_MODES[scene.readMode]],
    ["Gaussians in the file", header.gaussianCount.toLocaleString()],
    ["Live at this instant", readout.count.toLocaleString()],
    ["Duration", `${scene.duration} s`],
    [
      "Marginal cutoff",
      header.cutoff > 0
        ? String(effectiveCutoff(header))
        : `${effectiveCutoff(header)} (default; Header stores 0)`,
    ],
    ["SH degree", String(header.shDegree)],
    ["Profile", header.profile === "" ? "—" : header.profile],
    ["Written by", header.library === "" ? "—" : header.library],
    [
      "Chunk covering this instant",
      readout.intervals.length === 0
        ? "none"
        : readout.intervals.map((i) => `[${i.t0}, ${i.t1})`).join(" "),
    ],
  ];
  if (readout.transfer !== null) {
    rows.push([
      "Bytes read so far",
      `${formatBytes(readout.transfer.bytes)} of ${formatBytes(readout.transfer.size)}, in ${
        readout.transfer.reads
      } reads`,
    ]);
  }
  return (
    <div className={styles.facts}>
      <dl className={styles.factList}>
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {scene.notes.length > 0 && (
        <ul className={styles.notes}>
          {scene.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const READ_MODES = {
  indexed: "indexed — only the chunks whose [t0, t1) contains the instant on screen",
  streamed: "streamed — the resource read front to back in bounded blocks",
  "keyframe-delta": "keyframe-delta — composed front to back, then reconstructed at the instant",
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
