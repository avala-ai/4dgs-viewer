import { boundsOf } from "./camera.js";

/** Times to try when looking for a non-empty instant to frame the camera on. */
const FRAMING_PROBES = [0, 0.25, 0.5, 0.75, 0.999];

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
) {
  // The instant the visitor lands on. A refusal here is the file's answer to "can you open
  // this", and is allowed to propagate.
  const first = await playable.frameAt(0);
  // A file the visitor has already moved on from does not get to put a frame on the canvas
  // or move the camera; its caller will discard the rest of this open too.
  if (!isCurrent()) return [];
  currentRenderer()?.setFrame(first);
  if (camera === null) return [];

  const warnings = [];
  let bounds = boundsOf(first.centers, first.count);
  for (const fraction of FRAMING_PROBES) {
    if (bounds !== null) break;
    if (fraction === 0 || !(playable.duration > 0)) continue;
    const t = Math.min(playable.duration * fraction, lastInstant(playable.duration));
    try {
      const frame = await playable.frameAt(t);
      bounds ??= boundsOf(frame.centers, frame.count);
    } catch (failure) {
      // Not a refusal of the file: everything before this instant still decodes, and an
      // indexed reader only meets a bad chunk when something seeks into it.
      warnings.push(`t = ${t} does not decode — ${refusalName(failure)}: ${failure.message}`);
    }
  }
  if (!isCurrent()) return [];
  // Fixed probes can all miss a narrow visibility interval. The Header AABB is scene-wide
  // and is therefore the authoritative fallback for a sparse but otherwise valid scene.
  const framing = bounds ?? boundsFromAabb(playable.header?.aabb);
  camera.frame(
    framing === null ? [0, 0, 0] : framing.center,
    framing === null ? 1 : framing.radius,
  );
  return warnings;
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
