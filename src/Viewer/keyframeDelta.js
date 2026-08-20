/**
 * Adapt the SDK's reconstructed keyframe-delta gaussian state to the renderer's frame
 * layout. Composition, dequantization, validity windows, marginal cutoff, and SH assembly
 * all remain in `@4dgs/core`; this module only narrows float storage and interleaves alpha.
 */

import {
  DEFAULT_CUTOFF,
  reconstructKeyframeDelta as reconstructSdkKeyframeDelta,
} from "@4dgs/core";

/**
 * Reconstruct one composed chunk and adapt it to the viewer frame shape.
 *
 * `cutoff` is normally the Header value. A zero Header means the format default, so the
 * adapter supplies that normalized value to the SDK just as the gaussian-birth path does.
 */
export function reconstructKeyframeDelta(sequence, chunk, t, cutoff) {
  const effectiveCutoff = cutoff > 0 ? cutoff : DEFAULT_CUTOFF;
  const effectiveSequence =
    sequence.header.cutoff === effectiveCutoff
      ? sequence
      : {
          ...sequence,
          header: { ...sequence.header, cutoff: effectiveCutoff },
        };
  return frameFromKeyframeState(
    reconstructSdkKeyframeDelta(effectiveSequence, chunk, t),
  );
}

/** Convert an SDK `KeyframeDeltaGaussians` result to the renderer's upload layout. */
export function frameFromKeyframeState(state) {
  const centers = Float32Array.from(state.centers);
  const scales = Float32Array.from(state.scales);
  const rotations = Float32Array.from(state.rotations);
  const colors = new Float32Array(state.count * 4);
  for (let i = 0; i < state.count; i++) {
    colors[i * 4] = state.rgb[i * 3];
    colors[i * 4 + 1] = state.rgb[i * 3 + 1];
    colors[i * 4 + 2] = state.rgb[i * 3 + 2];
    colors[i * 4 + 3] = state.opacity[i];
  }

  return {
    time: state.t,
    count: state.count,
    centers,
    scales,
    rotations,
    colors,
    sh: state.sh?.values ?? null,
    shCoefficients: state.sh?.coefficients ?? 0,
    shDegree: state.sh?.degree ?? 0,
  };
}
