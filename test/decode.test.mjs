/**
 * What the viewer decodes, checked against the conformance corpus in Node.
 *
 * A renderer's wrong answer looks plausible: a scene with a gaussian too many draws
 * perfectly well. So nothing here is judged by eye. Every assertion is either a comparison
 * between the two read paths on the same bytes, or a comparison against a committed
 * expectation in `tests/conformance/data`, or a property the specification states
 * unconditionally (finite centres, positive scales, unit quaternions, opacity in `[0, 1]`).
 *
 * The corpus is generated, not committed. Run `python3 tests/conformance/generate.py` first;
 * these tests fail rather than skip when it is absent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CUTOFF,
  FourdgsError,
  MAGIC,
  MalformedFile,
  UnsupportedCodec,
  UnsupportedVersion,
  decodeKeyframeDeltaStreamed,
  reconstructKeyframeDelta as reconstructSdkKeyframeDelta,
} from "@4dgs/core";

import {
  ViewerLimitError,
  concatSh,
  effectiveCutoff,
  frameAtWithin,
  openScene,
} from "../src/Viewer/openScene.js";
import { frameCamera } from "../src/Viewer/framing.js";
import { reconstructKeyframeDelta } from "../src/Viewer/keyframeDelta.js";
import {
  BytesReadable,
  FAMILIES,
  FileReadable,
  NoFooterReadable,
  digest,
  instantsFor,
  round,
  variant,
  variants,
} from "./support/corpus.mjs";
import {
  cutAfterChunk,
  withBadSummaryCrc,
  withDuplicateIndexOffset,
  withHeaderDuration,
  withHeaderShDegree,
  withKeyframeIndexDepthMismatch,
  withPaddedHeader,
  withRedistributedIndexCounts,
  withStateChunksReversed,
} from "./support/mutate.mjs";

const GAUSSIAN_BIRTH = variants(FAMILIES.gaussianBirth);
const KEYFRAME_DELTA = variants(FAMILIES.keyframeDelta);
const INVALID = variants(FAMILIES.invalid);

/**
 * Whether this variant carries a Chunk Index with anything in it.
 *
 * The corpus encodes each optional feature in the variant's own filename — the same
 * convention `tests/conformance/run.py` reads a variant by — and the expectation records
 * the intervals, so a file that asks for an index but has no chunks to put in one (the
 * empty `NoData` variants) is correctly read front to back.
 */
const hasChunkIndex = (variant) =>
  variant.name.includes("UseChunkIndex") &&
  variant.expected.chunkIntervals.length > 0;

describe("Header defaults shown by the viewer", () => {
  it("reports the effective marginal cutoff, including the zero sentinel", () => {
    assert.equal(effectiveCutoff({ cutoff: 0 }), DEFAULT_CUTOFF);
    assert.equal(effectiveCutoff({ cutoff: 0.125 }), 0.125);
  });
});

describe("displayed frame reads have a liveness bound", () => {
  it("retires one never-settling read without polling or accumulating promises", async () => {
    let calls = 0;
    const playable = {
      frameAt() {
        calls += 1;
        return new Promise(() => {});
      },
    };
    await assert.rejects(
      () => frameAtWithin(playable, 1.25, 10),
      (error) =>
        error instanceof ViewerLimitError &&
        error.message.includes("frame at 1.25 s") &&
        error.message.includes("within 0.01 seconds"),
    );
    assert.equal(calls, 1);
  });
});

describe("the corpus decodes to the same scene on both read paths", () => {
  // Guards against a corpus, or a viewer, in which nothing ever reaches one of the paths.
  it("the corpus covers both read paths", () => {
    const indexed = GAUSSIAN_BIRTH.filter(hasChunkIndex);
    assert.ok(indexed.length > 1, "no indexed variants to check");
    assert.ok(
      GAUSSIAN_BIRTH.length - indexed.length > 0,
      "no unindexed variants to check",
    );
  });

  for (const entry of GAUSSIAN_BIRTH) {
    const { name, file, expected } = entry;
    it(name, async () => {
      const indexed = await openScene(new FileReadable(file));
      const streamed = await openScene(new NoFooterReadable(file));
      assert.equal(
        indexed.readMode,
        hasChunkIndex(entry) ? "indexed" : "streamed",
        "the read path the file asks for",
      );
      assert.equal(
        streamed.readMode,
        "streamed",
        "hiding the Footer must reach the other path",
      );

      // The Header, against the expectation every SDK is diffed on.
      assert.equal(indexed.header.temporalModel, expected.temporalModel);
      assert.equal(indexed.duration, expected.durationSec);
      assert.equal(indexed.header.cutoff, expected.cutoff);
      assert.equal(
        String(indexed.header.gaussianCount),
        expected.gaussianCount,
      );
      assert.equal(indexed.header.shDegree, expected.shDegree);

      for (const t of instantsFor(indexed.duration)) {
        // §8's seek rule, against the intervals the expectation lists.
        const covering = expected.chunkIntervals
          .filter(([t0, t1]) => t0 <= t && t < t1)
          .map(([t0, t1]) => `[${t0}, ${t1})`);
        for (const playable of [indexed, streamed]) {
          const seen = playable
            .intervalsAt(t)
            .map(({ t0, t1 }) => `[${t0}, ${t1})`);
          assert.deepEqual(
            seen,
            covering,
            `chunks covering t = ${t} on the ${playable.readMode} path`,
          );
        }

        const a = digest(await indexed.frameAt(t));
        const b = digest(await streamed.frameAt(t));
        assert.ok(a.finite, `t = ${t}: every centre is finite`);
        assert.ok(a.positiveScales, `t = ${t}: every scale is positive`);
        assert.ok(a.opacityInRange, `t = ${t}: every opacity is within [0, 1]`);
        assert.ok(
          a.worstQuaternion < 1e-3,
          `t = ${t}: quaternions are unit (${a.worstQuaternion})`,
        );
        assert.deepEqual(
          b,
          a,
          `t = ${t}: the indexed and streamed paths must decode the same scene`,
        );
      }
    });
  }
});

describe("object tracks are composed before a frame is exposed", () => {
  const tracked = GAUSSIAN_BIRTH.filter(
    ({ expected }) =>
      expected.objects?.tracks?.length > 0 && expected.states?.length > 0,
  );

  it("the corpus contains tracked object scenes", () => {
    assert.ok(tracked.length > 0, "no object-track variants to check");
  });

  for (const entry of tracked) {
    it(entry.name, async () => {
      const playables = [
        await openScene(new FileReadable(entry.file)),
        await openScene(new NoFooterReadable(entry.file)),
      ];
      for (const playable of playables) {
        for (const row of entry.expected.states) {
          const frame = await playable.frameAt(row.t);
          const actual = digest(frame);
          assert.equal(
            actual.count,
            Number(row.liveCount),
            `live count at t = ${row.t}`,
          );
          const expectedPosition = row.aggregate.positionSum.map(round);
          for (let axis = 0; axis < 3; axis++) {
            assert.ok(
              Math.abs(actual.centerSum[axis] - expectedPosition[axis]) <= 2e-6,
              `${playable.readMode} positionSum[${axis}] at t = ${row.t}: ` +
                `${actual.centerSum[axis]} != ${expectedPosition[axis]}`,
            );
          }
          assert.equal(
            actual.opacitySum,
            round(row.aggregate.opacitySum),
            `${playable.readMode} opacitySum at t = ${row.t}`,
          );
        }
      }
    });
  }
});

describe("camera framing survives asynchronous and sparse opens", () => {
  const empty = { count: 0, centers: new Float32Array() };

  it("installs an awaited frame on the renderer current after the await", async () => {
    let release;
    const first = new Promise((resolve) => {
      release = resolve;
    });
    const installed = { old: [], current: [] };
    const oldRenderer = { setFrame: (frame) => installed.old.push(frame) };
    const newRenderer = { setFrame: (frame) => installed.current.push(frame) };
    let renderer = oldRenderer;
    const framing = frameCamera(
      { duration: 1, frameAt: () => first },
      () => renderer,
      null,
      () => true,
    );
    renderer = newRenderer;
    release(empty);
    await framing;
    assert.deepEqual(installed.old, []);
    assert.deepEqual(installed.current, [empty]);
  });

  it("falls back to the Header AABB when fixed probes miss sparse visibility", async () => {
    const probes = [];
    const framed = [];
    const playable = {
      duration: 1,
      header: { aabb: [10, 20, 30, 14, 26, 38] },
      frameAt: async (t) => {
        probes.push(t);
        return empty;
      },
    };
    await frameCamera(
      playable,
      () => ({ setFrame() {} }),
      { frame: (center, radius) => framed.push({ center, radius }) },
      () => true,
    );
    assert.deepEqual(probes, [0, 0.25, 0.5, 0.75, 0.999]);
    assert.deepEqual(framed[0].center, [12, 23, 34]);
    assert.equal(framed[0].radius, Math.hypot(4, 6, 8) / 2);
  });

  it("does not fetch later instants once the landing frame has bounds", async () => {
    const probes = [];
    const frame = { count: 1, centers: new Float32Array([3, 4, 5]) };
    await frameCamera(
      {
        duration: 10,
        header: { aabb: [-100, -100, -100, 100, 100, 100] },
        frameAt: async (t) => {
          probes.push(t);
          return frame;
        },
      },
      () => ({ setFrame() {} }),
      { frame() {} },
      () => true,
    );
    assert.deepEqual(probes, [0]);
  });

  it("bounds optional probes that never settle and opens with Header bounds", async () => {
    const probes = [];
    const framed = [];
    const warnings = await frameCamera(
      {
        duration: 1,
        header: { aabb: [10, 20, 30, 14, 26, 38] },
        frameAt: (t) => {
          probes.push(t);
          return t === 0 ? Promise.resolve(empty) : new Promise(() => {});
        },
      },
      () => ({ setFrame() {} }),
      { frame: (center, radius) => framed.push({ center, radius }) },
      () => true,
      undefined,
      10,
    );
    assert.deepEqual(probes, [0, 0.25]);
    assert.deepEqual(framed[0].center, [12, 23, 34]);
    assert.equal(framed[0].radius, Math.hypot(4, 6, 8) / 2);
    assert.match(warnings[0], /did not answer within 10 ms/);
  });
});

describe("spherical harmonics follow the nonempty chunks at an instant", () => {
  it("does not require an empty overlapping chunk to carry an SH block", () => {
    const values = Uint8Array.from({ length: 9 }, (_, index) => index + 1);
    const merged = concatSh([
      {
        gaussians: { count: 1 },
        sh: { degree: 1, coefficients: 3, values, bands: [1] },
      },
      { gaussians: { count: 0 }, sh: null },
    ]);
    assert.equal(merged.degree, 1);
    assert.equal(merged.count, 1);
    assert.deepEqual(merged.values, values);
  });
});

describe("keyframe-delta reconstruction matches the canonical statement", () => {
  for (const { name, file, expected } of KEYFRAME_DELTA) {
    it(name, async () => {
      const playable = await openScene(new FileReadable(file));
      assert.equal(playable.readMode, "keyframe-delta");
      assert.equal(playable.header.temporalModel, expected.temporalModel);
      assert.equal(playable.duration, expected.durationSec);
      assert.ok(
        expected.states.length > 0,
        "the committed expectation probes at least one instant",
      );

      for (const row of expected.states) {
        const frame = await playable.frameAt(row.t);
        // Every window in this corpus covers the whole timeline and no probe falls under
        // the cutoff, so the visible population is the composed one. Where that stops being
        // true the viewer is right to differ — see the window/cutoff tests below — but on
        // these files any difference is a bug in this page.
        assert.equal(
          frame.count,
          Number(row.liveCount),
          `live count at t = ${row.t}`,
        );
        let px = 0;
        let py = 0;
        let pz = 0;
        let opacity = 0;
        for (let i = 0; i < frame.count; i++) {
          px += frame.centers[i * 3];
          py += frame.centers[i * 3 + 1];
          pz += frame.centers[i * 3 + 2];
          opacity += frame.colors[i * 4 + 3];
        }
        assert.deepEqual(
          [round(px), round(py), round(pz)],
          row.aggregate.positionSum.map(round),
          `positionSum at t = ${row.t}`,
        );
        assert.equal(
          round(opacity),
          round(row.aggregate.opacitySum),
          `opacitySum at t = ${row.t}`,
        );
        assert.deepEqual(
          Array.from(frame.centers, round),
          row.sample.positions.flat().map(round),
          `sample positions at t = ${row.t}`,
        );
        assert.deepEqual(
          Array.from(frame.scales, round),
          row.sample.scales.flat().map(round),
          `sample scales at t = ${row.t}`,
        );
      }
    });
  }

  it("a complete file refuses when the Chunk Index disagrees with a Delta Chunk", async () => {
    const source = variant(
      "keyframe/KeyframeDelta-UseChunkIndex-UseCrc-UseStatistics.4dgs",
    );
    const { bytes, indexedDepth, chunkDepth, instant } =
      withKeyframeIndexDepthMismatch(source.bytes);
    await assert.rejects(
      async () => (await openScene(new BytesReadable(bytes))).frameAt(instant),
      (error) =>
        error instanceof MalformedFile &&
        error.message.includes(`depth ${indexedDepth}`) &&
        error.message.includes(`${chunkDepth} delta chunks`) &&
        error.message.includes("index and the file disagree"),
    );
  });
});

describe("an invalid file is refused in the decoder's own words", () => {
  for (const { name, file, expected } of INVALID) {
    it(name, async () => {
      assert.ok(
        typeof expected.refused === "string" && expected.refused.length > 0,
      );
      let refusal = null;
      try {
        const playable = await openScene(new FileReadable(file));
        for (const t of instantsFor(playable.duration)) {
          await playable.frameAt(t);
        }
      } catch (error) {
        refusal = error;
      }
      assert.ok(
        refusal !== null,
        "every invalid variant must be refused somewhere",
      );
      assert.ok(
        refusal instanceof FourdgsError,
        `refused with ${refusal?.constructor?.name}, not a 4dgs refusal`,
      );
      assert.equal(refusalTag(refusal), expected.refused, refusal.message);
      // §6: a refusal names the value, not just the fact. The page prints this sentence as
      // it came, so a message that stopped saying anything would be invisible here
      // otherwise.
      assert.ok(
        refusal.message.length > 40 && /\d|'/.test(refusal.message),
        `refusal does not name a value: ${refusal.message}`,
      );
    });
  }
});

function refusalTag(error) {
  const message = error.message;
  if (error instanceof UnsupportedVersion) {
    return message.startsWith("not a 4dgs file:") ||
      /major version 1\b/.test(message)
      ? "magic-mismatch"
      : "unsupported-major-version";
  }
  if (error instanceof UnsupportedCodec) {
    if (/temporal model/.test(message)) return "unknown-temporal-model";
    if (/Quantization.*scheme/.test(message))
      return "unknown-quantization-scheme";
    if (/stream codec/.test(message)) return "unknown-stream-codec";
  }
  if (error instanceof MalformedFile && /window index/.test(message)) {
    return "window-index-out-of-range";
  }
  return `unmapped:${error.constructor.name}`;
}

describe("§5.5: a chunk's gaussians are invisible outside its interval", () => {
  // The file this PR was opened over: a gaussian whose validity window is [14, 16) stored
  // in the chunk [14, 15), so at t = 15 the chunk interval and the window disagree.
  const divergent =
    "TenWindows-DeltaStreams-Quantized-UseChunkIndex-UseChunks-UseCrc.4dgs";

  it("the streamed path applies the gate the indexed path gets for free", async () => {
    const { file, expected } = variant(divergent);
    const indexed = await openScene(new FileReadable(file));
    const streamed = await openScene(new NoFooterReadable(file));
    // An instant where a chunk boundary and a validity window disagree: the end of a chunk
    // that is not the end of the file, taken from the expectation rather than assumed.
    const boundaries = expected.chunkIntervals
      .map(([, t1]) => t1)
      .filter((t1) => t1 < expected.durationSec);
    assert.ok(boundaries.length > 0);
    for (const t of boundaries) {
      const a = await indexed.frameAt(t);
      const b = await streamed.frameAt(t);
      assert.equal(
        b.count,
        a.count,
        `t = ${t}: the streamed path drew ${b.count} where the indexed path drew ${a.count}`,
      );
      assert.deepEqual(digest(b), digest(a), `t = ${t}`);
    }
  });

  it("a Chunk Index whose counts do not match its chunks does not get to gate", async () => {
    const { bytes, firstEntry, claimed } = withRedistributedIndexCounts(
      variant("TenWindows-UseChunkIndex-UseChunks-UseCrc.4dgs").bytes,
    );
    const playable = await openScene(
      new BytesReadable(bytes, { hideFooter: true }),
    );
    assert.equal(
      playable.readMode,
      "streamed",
      "the gate under test is the streamed one",
    );
    const note = playable.notes.find((line) =>
      line.includes(`chunk at ${firstEntry.chunkOffset}`),
    );
    assert.ok(
      note !== undefined,
      `no note named the disagreeing chunk; notes were:\n${playable.notes.join("\n")}`,
    );
    assert.match(
      note,
      new RegExp(`holds ${firstEntry.gaussianCount} gaussians`),
    );
    assert.match(note, new RegExp(`index entry says ${claimed}`));
  });

  it("an untouched index does gate, so the check above is not vacuous", async () => {
    const playable = await openScene(
      new BytesReadable(
        variant("TenWindows-UseChunkIndex-UseChunks-UseCrc.4dgs").bytes.slice(),
        {
          hideFooter: true,
        },
      ),
    );
    assert.equal(playable.readMode, "streamed");
    assert.ok(
      !playable.notes.some((line) =>
        line.includes("Every other visibility rule is applied"),
      ),
      `a conforming file lost its gate:\n${playable.notes.join("\n")}`,
    );
  });

  it("a CRC-rejected index falls back to the streamed path", async () => {
    const bytes = withBadSummaryCrc(
      variant("TenWindows-UseChunkIndex-UseChunks-UseCrc.4dgs").bytes,
    );
    const playable = await openScene(new BytesReadable(bytes));
    assert.equal(playable.readMode, "streamed");
    assert.ok(playable.notes.some((line) => line.includes("summary CRC")));
  });

  it("duplicate Chunk offsets cannot build a streamed interval gate", async () => {
    const { bytes, duplicateOffset } = withDuplicateIndexOffset(
      variant("TenWindows-UseChunkIndex-UseChunks-UseCrc.4dgs").bytes,
    );
    const playable = await openScene(
      new BytesReadable(bytes, { hideFooter: true }),
    );
    assert.equal(playable.readMode, "streamed");
    assert.ok(
      playable.notes.some(
        (line) =>
          line.includes(`offset ${duplicateOffset} more than once`) &&
          line.includes("one to one"),
      ),
    );
    assert.deepEqual(
      playable.intervalsAt(0),
      [],
      "an index rejected for visibility cannot still label the displayed instant",
    );
  });
});

describe("the keyframe-delta adapter uses the SDK's reconstructed gaussian state", () => {
  const source =
    "keyframe/KeyframeOnly-UseChunkIndex-UseCrc-UseStatistics.4dgs";

  /** One composed chunk of a corpus file at `t`. */
  async function chunkAt(t) {
    const sequence = await decodeKeyframeDeltaStreamed(variant(source).bytes);
    const chunk = sequence.chunks.find((c) => c.t0 <= t && t < c.t1);
    assert.ok(chunk !== undefined);
    return { sequence, chunk };
  }

  it("converts every public value without reaching into private composed columns", async () => {
    const t = 2;
    const { sequence, chunk } = await chunkAt(t);
    const state = reconstructSdkKeyframeDelta(sequence, chunk, t);
    const frame = reconstructKeyframeDelta(
      sequence,
      chunk,
      t,
      sequence.header.cutoff,
    );
    assert.equal(frame.count, state.count);
    assert.deepEqual([...frame.centers], [...Float32Array.from(state.centers)]);
    assert.deepEqual([...frame.scales], [...Float32Array.from(state.scales)]);
    assert.deepEqual(
      [...frame.rotations],
      [...Float32Array.from(state.rotations)],
    );
    for (let i = 0; i < state.count; i++) {
      assert.deepEqual(
        [...frame.colors.subarray(i * 4, i * 4 + 4)],
        [
          ...Float32Array.from([
            ...state.rgb.subarray(i * 3, i * 3 + 3),
            state.opacity[i],
          ]),
        ],
      );
    }
    assert.equal(frame.shDegree, state.sh?.degree ?? 0);
    assert.equal(frame.shCoefficients, state.sh?.coefficients ?? 0);
    assert.deepEqual(frame.sh, state.sh?.values ?? null);
  });

  it("forwards an explicit cutoff through the SDK reconstruction", async () => {
    const t = 2;
    const { sequence, chunk } = await chunkAt(t);
    const strict = { ...sequence, header: { ...sequence.header, cutoff: 1 } };
    const expected = reconstructSdkKeyframeDelta(strict, chunk, t);
    const frame = reconstructKeyframeDelta(sequence, chunk, t, 1);
    assert.equal(frame.count, expected.count);
    assert.deepEqual(
      [...frame.centers],
      [...Float32Array.from(expected.centers)],
    );
    assert.deepEqual(
      [...frame.colors.filter((_, i) => i % 4 === 3)],
      [...Float32Array.from(expected.opacity)],
    );
  });
});

describe("§11.10: a keyframe-delta timeline ends where its chunks do", () => {
  const source =
    "keyframe/KeyframeOnly-UseChunkIndex-UseCrc-UseStatistics.4dgs";

  it("a file cut after a complete chunk plays to that chunk's t1 and refuses past it", async () => {
    const whole = variant(source);
    const sequence = await decodeKeyframeDeltaStreamed(whole.bytes);
    const keep = 1;
    const { bytes } = cutAfterChunk(whole.bytes, keep);
    const covered = Math.max(
      ...sequence.chunks.slice(0, keep + 1).map((c) => c.t1),
    );
    assert.ok(
      covered < whole.expected.durationSec,
      "the cut must actually shorten the timeline",
    );

    const playable = await openScene(new BytesReadable(bytes));
    assert.equal(playable.duration, covered);
    assert.ok(
      playable.notes.some((note) => note.includes(`[0, ${covered})`)),
      `no note said where the chunks stop:\n${playable.notes.join("\n")}`,
    );
    await assert.rejects(
      () => playable.frameAt(whole.expected.durationSec - 1e-6),
      MalformedFile,
      "an instant past the last complete chunk must be refused, not answered with stale state",
    );
  });

  it("storage order is not time order: coverage comes from the largest t1", async () => {
    const whole = variant(source);
    const inOrder = await openScene(new BytesReadable(whole.bytes.slice()));
    const { bytes, chunkCount } = withStateChunksReversed(whole.bytes);
    assert.ok(chunkCount > 1);
    const reversed = await openScene(new BytesReadable(bytes));

    assert.equal(reversed.duration, inOrder.duration);
    assert.equal(reversed.duration, whole.expected.durationSec);
    assert.deepEqual(
      reversed.notes,
      inOrder.notes,
      "a file stored newest-first is not a truncated file",
    );
    for (const t of instantsFor(inOrder.duration)) {
      assert.deepEqual(
        digest(await reversed.frameAt(t)),
        digest(await inOrder.frameAt(t)),
        `t = ${t}: reordering storage must not change what the file means`,
      );
    }
  });

  it("a complete file whose chunks stop early is malformed, not truncated", async () => {
    const whole = variant(source);
    const duration = whole.expected.durationSec + 1;
    const bytes = withHeaderDuration(whole.bytes, duration);
    await assert.rejects(
      () => openScene(new BytesReadable(bytes)),
      (error) =>
        error instanceof MalformedFile &&
        error.message.includes(`duration_sec ${duration}`) &&
        error.message.includes("complete"),
    );
  });
});

describe("the temporal model is read from the Header, whatever size it is", () => {
  it("a keyframe-delta Header past 64 KiB still opens as keyframe-delta", async () => {
    const whole = variant(
      "keyframe/KeyframeOnly-UseChunkIndex-UseCrc-UseStatistics.4dgs",
    );
    const { bytes, headerRecordBytes } = withPaddedHeader(
      whole.bytes,
      128 * 1024,
    );
    assert.ok(
      headerRecordBytes > 64 * 1024,
      "the padded Header must exceed a 64 KiB probe",
    );

    const padded = await openScene(new BytesReadable(bytes));
    const plain = await openScene(new BytesReadable(whole.bytes.slice()));
    assert.equal(padded.readMode, "keyframe-delta");
    assert.equal(padded.duration, plain.duration);
    for (const t of instantsFor(plain.duration)) {
      assert.deepEqual(
        digest(await padded.frameAt(t)),
        digest(await plain.frameAt(t)),
        `t = ${t}`,
      );
    }
  });

  it("refuses an oversized declared Header before a decoder requests its range", async () => {
    const declared = 64 * 1024 * 1024 + 1;
    const prefix = new Uint8Array(MAGIC.length + 9);
    prefix.set(MAGIC);
    prefix[MAGIC.length] = 0x01;
    new DataView(prefix.buffer).setBigUint64(
      MAGIC.length + 1,
      BigInt(declared),
      true,
    );
    const source = {
      largestRead: 0,
      async size() {
        return BigInt(prefix.length + declared);
      },
      async read(offset, length) {
        const at = Number(offset);
        const count = Number(length);
        this.largestRead = Math.max(this.largestRead, count);
        const out = new Uint8Array(count);
        if (at < prefix.length) {
          out.set(prefix.subarray(at, Math.min(prefix.length, at + count)));
        }
        return out;
      },
    };

    await assert.rejects(
      () => openScene(source),
      (error) =>
        error instanceof ViewerLimitError &&
        error.message.includes(`declares ${declared} content bytes`),
    );
    assert.ok(
      source.largestRead <= 64 * 1024,
      `largest range read was ${source.largestRead}`,
    );
  });
});

describe("indexed SH bands agree with the Header", () => {
  it("refuses a non-empty Chunk whose physical bands stop below Header.sh_degree", async () => {
    const whole = variant("MixedLifetimes-SHDegree2-UseChunkIndex-UseCrc.4dgs");
    const bytes = withHeaderShDegree(whole.bytes, 3);
    const playable = await openScene(new BytesReadable(bytes));
    assert.equal(playable.readMode, "indexed");
    await assert.rejects(
      () => playable.frameAt(0),
      (error) =>
        error instanceof MalformedFile &&
        error.message.includes("decodes SH degree 2") &&
        error.message.includes("Header declares SH degree 3"),
    );
  });

  it("refuses a non-empty Chunk whose physical bands exceed Header.sh_degree", async () => {
    const whole = variant("MixedLifetimes-SHDegree2-UseChunkIndex-UseCrc.4dgs");
    const bytes = withHeaderShDegree(whole.bytes, 1);
    const playable = await openScene(new BytesReadable(bytes));
    assert.equal(playable.readMode, "indexed");
    await assert.rejects(
      () => playable.frameAt(0),
      (error) =>
        error instanceof MalformedFile &&
        error.message.includes("decodes SH degree 2") &&
        error.message.includes("Header declares SH degree 1"),
    );
  });
});

describe("indexed Chunk cache identities are unique", () => {
  it("refuses a CRC-valid index that names one physical Chunk twice", async () => {
    const whole = variant("TenWindows-UseChunkIndex-UseChunks-UseCrc.4dgs");
    const { bytes, duplicateOffset } = withDuplicateIndexOffset(whole.bytes);
    const playable = await openScene(new BytesReadable(bytes));
    assert.equal(playable.readMode, "indexed");
    await assert.rejects(
      () => playable.frameAt(0),
      (error) =>
        error instanceof MalformedFile &&
        error.message.includes(`both name chunk_offset ${duplicateOffset}`),
    );
  });
});
