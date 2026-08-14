import { boundsOf } from "./camera.js";
import { FRAME_READ_TIMEOUT_MS, frameAtWithin } from "./openScene.js";

/** Times to try when looking for a non-empty instant to frame the camera on. */
const FRAMING_PROBES = [0, 0.25, 0.5, 0.75, 0.999];
/** Optional probes may improve the landing camera, but may not hold an open forever. */
const FRAMING_PROBE_TIMEOUT_MS = 1500;
const PROBE_TIMED_OUT = Symbol("framing probe timed out");

/**
 * Put the camera round the scene, using the first instant that has anything in it.
 *
 * `currentRenderer` is deliberately a function. A range-backed `frameAt(0)` can still be
 * pending when WebGL restores and replaces the renderer, so the renderer must be acquired
 * after the await rather than captured before it.
 */
export async function frameCamera(
  playable,
  currentRenderer,
  camera,
  isCurrent,
  refusalName = (failure) => failure?.name ?? "Error",
  probeTimeoutMs = FRAMING_PROBE_TIMEOUT_MS,
  landingTimeoutMs = FRAME_READ_TIMEOUT_MS,
) {
  // The instant the visitor lands on. A refusal here is the file's answer to "can you open
  // this", and is allowed to propagate. It still shares the displayed-frame liveness
  // bound: metadata opening successfully does not entitle its first Chunk to hang forever.
  const first = await frameAtWithin(playable, 0, landingTimeoutMs);
  // A file the visitor has already moved on from does not get to put a frame on the canvas
  // or move the camera; its caller will discard the rest of this open too.
  if (!isCurrent()) return [];
  const landingRenderer = currentRenderer();
  landingRenderer?.setFrame(first);
  if (camera === null) return [];

  const warnings = [];
  let bounds = boundsOf(first.centers, first.count);
  for (const fraction of FRAMING_PROBES) {
    if (bounds !== null) break;
    if (fraction === 0 || !(playable.duration > 0)) continue;
    const t = Math.min(playable.duration * fraction, lastInstant(playable.duration));
    try {
      const frame = await within(playable.frameAt(t), probeTimeoutMs);
      if (frame === PROBE_TIMED_OUT) {
        warnings.push(
          `t = ${t} camera framing probe did not answer within ${probeTimeoutMs} ms; ` +
            "the scene opened using its Statistics bounds",
        );
        break;
      }
      bounds ??= boundsOf(frame.centers, frame.count);
    } catch (failure) {
      // Not a refusal of the file: everything before this instant still decodes, and an
      // indexed reader only meets a bad chunk when something seeks into it.
      warnings.push(`t = ${t} does not decode — ${refusalName(failure)}: ${failure.message}`);
    }
  }
  if (!isCurrent()) return [];
  // WebGL may have restored while an optional probe was in flight. Its replacement
  // renderer has no GPU copy of time zero; reinstall that landing answer before the
  // caller marks zero rendered. Avoid a duplicate upload when the renderer is unchanged.
  const settledRenderer = currentRenderer();
  if (settledRenderer !== landingRenderer) settledRenderer?.setFrame(first);
  // Fixed probes can all miss a narrow visibility interval. The Statistics AABB is scene-wide
  // and is therefore the authoritative fallback for a sparse but otherwise valid scene.
  const framing = bounds ?? boundsFromAabb(playable.statistics?.aabb);
  camera.frame(
    framing === null ? [0, 0, 0] : framing.center,
    framing === null ? 1 : framing.radius,
  );
  return warnings;
}

/** Bound an optional operation without leaving its eventual rejection unobserved. */
async function within(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(PROBE_TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A scene-wide framing fallback for sparse visibility that fixed time probes can miss. */
export function boundsFromAabb(aabb) {
  if (!Array.isArray(aabb) || aabb.length !== 6 || !aabb.every(Number.isFinite)) return null;
  const center = [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
  const radius = Math.hypot(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]) / 2;
  if (!center.every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0) return null;
  return { center, radius };
}

/** The largest instant the half-open timeline `[0, duration)` actually contains. */
export function lastInstant(duration) {
  if (!(duration > 0)) return 0;
  return Math.max(0, duration - Math.max(duration * 1e-9, Number.EPSILON));
}
