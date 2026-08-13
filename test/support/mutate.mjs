/**
 * Corpus files bent in specific, documented ways.
 *
 * Each function here produces the file a finding described and the corpus does not contain.
 * They are byte edits on a generated variant rather than hand-written scenes, so what they
 * prove is still anchored to `tests/conformance/data` — only one property of a real file is
 * changed, and the rest of it stays exactly what the generator wrote.
 */

import {
  Cursor,
  MAGIC,
  Opcode,
  RECORD_HEADER_BYTES,
  crc32,
  iterateRecords,
  parseChunkIndexEntry,
} from "@4dgs/core";

/** Offset within a Chunk Index entry's content of its `u32` gaussian_count (spec §5.9). */
const INDEX_ENTRY_COUNT_AT = 8 + 8 + 8 + 8;
const INDEX_ENTRY_OFFSET_AT = 8 + 8;

function records(bytes) {
  return [...iterateRecords(bytes, MAGIC.length)];
}

function join(pieces) {
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/**
 * One gaussian moved from the first Chunk Index entry to the second.
 *
 * The *total* over the index is unchanged, which is the whole point: a reader that checks
 * only the sum sees nothing wrong and lays the decoded rows out against the wrong chunk
 * intervals.
 */
export function withRedistributedIndexCounts(bytes) {
  const entries = records(bytes)
    .filter((record) => record.opcode === Opcode.ChunkIndex)
    .map((record) => ({
      contentAt: record.offset + RECORD_HEADER_BYTES,
      parsed: parseChunkIndexEntry(record.content),
    }));
  if (entries.length < 2)
    throw new Error("this variant has fewer than two Chunk Index entries");
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(
    entries[0].contentAt + INDEX_ENTRY_COUNT_AT,
    entries[0].parsed.gaussianCount - 1,
    true,
  );
  view.setUint32(
    entries[1].contentAt + INDEX_ENTRY_COUNT_AT,
    entries[1].parsed.gaussianCount + 1,
    true,
  );
  return {
    bytes: out,
    firstEntry: entries[0].parsed,
    claimed: entries[0].parsed.gaussianCount - 1,
  };
}

/** Two index entries point at the same Chunk, leaving another Chunk unrepresented. */
export function withDuplicateIndexOffset(bytes) {
  const entries = records(bytes).filter(
    (record) => record.opcode === Opcode.ChunkIndex,
  );
  if (entries.length < 2)
    throw new Error("this variant has fewer than two Chunk Index entries");
  const first = parseChunkIndexEntry(entries[0].content);
  const out = bytes.slice();
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
    entries[1].offset + RECORD_HEADER_BYTES + INDEX_ENTRY_OFFSET_AT,
    BigInt(first.chunkOffset),
    true,
  );
  refreshSummaryCrc(out);
  return { bytes: out, duplicateOffset: first.chunkOffset };
}

/** Make one keyframe-delta index entry disagree with its Delta Chunk's depth. */
export function withKeyframeIndexDepthMismatch(bytes) {
  const entry = records(bytes)
    .filter((record) => record.opcode === Opcode.ChunkIndex)
    .map((record) => ({ record, parsed: parseChunkIndexEntry(record.content) }))
    .find(({ parsed }) => parsed.extended && parsed.kind === 1);
  if (entry === undefined)
    throw new Error("this variant has no delta Chunk Index entry");
  const content = entry.record.offset + RECORD_HEADER_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bandCount = view.getUint32(content + 36, true);
  const deltaBlock = content + 40 + bandCount * 17;
  const depthAt = deltaBlock + 1 + 1 + 8 + 8;
  const out = bytes.slice();
  const changed = entry.parsed.depth + 1;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
    depthAt,
    changed,
    true,
  );
  refreshSummaryCrc(out);
  return {
    bytes: out,
    indexedDepth: changed,
    chunkDepth: entry.parsed.depth,
    instant: entry.parsed.t0,
  };
}

/** Corrupt only the Footer's summary CRC, leaving every index entry byte intact. */
export function withBadSummaryCrc(bytes) {
  const footer = records(bytes).find(
    (record) => record.opcode === Opcode.Footer,
  );
  if (footer === undefined) throw new Error("no Footer record in this variant");
  const out = bytes.slice();
  const at = footer.offset + RECORD_HEADER_BYTES + 16;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(at, view.getUint32(at, true) ^ 0x01000000, true);
  return out;
}

/** Change only Header.duration_sec; it is outside the Footer's summary CRC region. */
export function withHeaderDuration(bytes, duration) {
  const header = records(bytes).find(
    (record) => record.opcode === Opcode.Header,
  );
  if (header === undefined) throw new Error("no Header record in this variant");
  const view = new DataView(
    header.content.buffer,
    header.content.byteOffset,
    header.content.byteLength,
  );
  let at = 0;
  for (let i = 0; i < 2; i++) {
    const length = view.getUint32(at, true);
    at += 4 + length;
  }
  const out = bytes.slice();
  new DataView(out.buffer, out.byteOffset, out.byteLength).setFloat64(
    header.offset + RECORD_HEADER_BYTES + at,
    duration,
    true,
  );
  return out;
}

/** Change only Header.sh_degree; it is outside the Footer's summary CRC region. */
export function withHeaderShDegree(bytes, degree) {
  const header = records(bytes).find(
    (record) => record.opcode === Opcode.Header,
  );
  if (header === undefined) throw new Error("no Header record in this variant");
  const cursor = new Cursor(header.content);
  cursor.string();
  cursor.string();
  cursor.f64();
  cursor.u64();
  cursor.f64();
  cursor.string();
  cursor.f64s(6);
  const out = bytes.slice();
  out[header.offset + RECORD_HEADER_BYTES + cursor.pos] = degree;
  return out;
}

/**
 * The Chunk records written in reverse file order.
 *
 * A conforming `keyframe-delta` file's state chunks tile the timeline in *time* order;
 * nothing says they are stored in it. Safe only on a file whose chunks are all independent
 * keyframes, since a delta names its reference by absolute offset.
 */
export function withStateChunksReversed(bytes) {
  const all = records(bytes);
  const chunks = all.filter((record) => record.opcode === Opcode.Chunk);
  if (chunks.length < 2)
    throw new Error("this variant has fewer than two state chunks");
  if (all.some((record) => record.opcode === Opcode.DeltaChunk)) {
    throw new Error(
      "reversing storage order is only safe for a file with no delta chunks",
    );
  }
  const pieces = [bytes.slice(0, MAGIC.length)];
  const relocatedChunks = new Map();
  let outputOffset = MAGIC.length;
  let placed = false;
  for (const record of all) {
    if (record.opcode === Opcode.Chunk) {
      if (!placed) {
        placed = true;
        for (const chunk of [...chunks].reverse()) {
          pieces.push(bytes.slice(chunk.offset, chunk.offset + chunk.length));
          relocatedChunks.set(chunk.offset, outputOffset);
          outputOffset += chunk.length;
        }
      }
      continue;
    }
    pieces.push(bytes.slice(record.offset, record.offset + record.length));
    outputOffset += record.length;
  }
  pieces.push(MAGIC);
  const out = join(pieces);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const record of records(out)) {
    if (record.opcode !== Opcode.ChunkIndex) continue;
    const entry = parseChunkIndexEntry(record.content);
    const relocated = relocatedChunks.get(entry.chunkOffset);
    if (relocated === undefined) continue;
    view.setBigUint64(
      record.offset + RECORD_HEADER_BYTES + INDEX_ENTRY_OFFSET_AT,
      BigInt(relocated),
      true,
    );
  }
  refreshSummaryCrc(out);
  return { bytes: out, chunkCount: chunks.length };
}

/** Recompute the Footer checksum after a test deliberately edits summary bytes. */
function refreshSummaryCrc(bytes) {
  const footer = records(bytes).find(
    (record) => record.opcode === Opcode.Footer,
  );
  if (footer === undefined) throw new Error("this variant has no Footer");
  const content = footer.offset + RECORD_HEADER_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const summaryStart = Number(view.getBigUint64(content, true));
  view.setUint32(
    content + 16,
    crc32(bytes.subarray(summaryStart, footer.offset)),
    true,
  );
}

/**
 * The same file with its Header record grown past `atLeast` bytes.
 *
 * Grown by adding to the attributes map, which is the Header's last field: a `u32` byte
 * length followed by exactly that many bytes of `string` key / `string` value pairs (see
 * `parseHeader` and `Cursor.stringMap`). Everything before it is untouched, so the file
 * still says exactly what it said, at a size a fixed-size probe of the front cannot hold.
 */
export function withPaddedHeader(bytes, atLeast) {
  const header = records(bytes).find(
    (record) => record.opcode === Opcode.Header,
  );
  if (header === undefined) throw new Error("no Header record in this variant");
  const content = header.content;
  const view = new DataView(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );

  // The map block is the tail of the content, so its length field is the one u32 whose
  // value places the block end exactly at the end of the content.
  let blockAt = -1;
  for (let at = 0; at + 4 <= content.length; at++) {
    if (at + 4 + view.getUint32(at, true) === content.length) {
      blockAt = at;
      break;
    }
  }
  if (blockAt < 0)
    throw new Error("could not locate the Header's attributes map");
  const blockLength = view.getUint32(blockAt, true);

  const text = new TextEncoder();
  const string = (value) => {
    const encoded = text.encode(value);
    const out = new Uint8Array(4 + encoded.length);
    new DataView(out.buffer).setUint32(0, encoded.length, true);
    out.set(encoded, 4);
    return out;
  };
  const pad = Math.max(atLeast - content.length, 1);
  const added = join([string("test-padding"), string("x".repeat(pad))]);

  const lengthField = new Uint8Array(4);
  new DataView(lengthField.buffer).setUint32(
    0,
    blockLength + added.length,
    true,
  );
  const newContent = join([
    content.subarray(0, blockAt),
    lengthField,
    content.subarray(blockAt + 4),
    added,
  ]);

  const framed = new Uint8Array(RECORD_HEADER_BYTES + newContent.length);
  framed[0] = Opcode.Header;
  new DataView(framed.buffer).setBigUint64(1, BigInt(newContent.length), true);
  framed.set(newContent, RECORD_HEADER_BYTES);

  const out = join([
    bytes.slice(0, header.offset),
    framed,
    bytes.slice(header.offset + header.length),
  ]);
  relocateAbsoluteOffsets(
    out,
    records(bytes),
    header,
    framed.length - header.length,
  );
  return { bytes: out, headerRecordBytes: framed.length };
}

/**
 * Keep every absolute offset valid after a front-matter record grows.
 *
 * Chunk indexes, Delta Chunk references, Summary Offsets and the Footer all name physical
 * byte offsets. A large-Header fixture is conforming only if those values move with the
 * records; merely splicing bytes would test a broken index rather than header framing.
 */
function relocateAbsoluteOffsets(out, originalRecords, changed, shift) {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const relocated = (offset) => offset + (offset > changed.offset ? shift : 0);
  const addShift = (at) => {
    const value = Number(view.getBigUint64(at, true));
    if (value > changed.offset)
      view.setBigUint64(at, BigInt(value + shift), true);
  };

  let footerOffset = null;
  for (const record of originalRecords) {
    if (record.offset <= changed.offset) continue;
    const at = relocated(record.offset) + RECORD_HEADER_BYTES;
    if (record.opcode === Opcode.DeltaChunk) {
      addShift(at + 21); // reference_offset
      addShift(at + 29); // keyframe_offset
    } else if (record.opcode === Opcode.ChunkIndex) {
      addShift(at + 16); // chunk_offset
      const bandCount = view.getUint32(at + 36, true);
      for (let band = 0; band < bandCount; band++)
        addShift(at + 40 + band * 17 + 1);
      const deltaBlock = at + 40 + bandCount * 17;
      const contentLength = Number(
        view.getBigUint64(relocated(record.offset) + 1, true),
      );
      if (contentLength - (deltaBlock - at) >= 28) {
        addShift(deltaBlock + 2); // reference_offset
        addShift(deltaBlock + 10); // keyframe_offset
      }
    } else if (record.opcode === Opcode.SummaryOffset) {
      addShift(at + 1); // group_start
    } else if (record.opcode === Opcode.Footer) {
      footerOffset = relocated(record.offset);
      addShift(at); // summary_start
      addShift(at + 8); // summary_offset_start
    }
  }

  if (footerOffset !== null) {
    const footerContent = footerOffset + RECORD_HEADER_BYTES;
    const summaryStart = Number(view.getBigUint64(footerContent, true));
    const checksum =
      summaryStart === 0 ? 0 : crc32(out.subarray(summaryStart, footerOffset));
    view.setUint32(footerContent + 16, checksum, true);
  }
}

/**
 * The file cut immediately after its `n`th state chunk.
 *
 * Returns the cut bytes and that chunk's own `[t0, t1)` read out of the file, so a test can
 * assert against the file's statement of where its chunks end rather than against a number.
 */
export function cutAfterChunk(bytes, n) {
  const chunkRecords = records(bytes).filter(
    (record) =>
      record.opcode === Opcode.Chunk || record.opcode === Opcode.DeltaChunk,
  );
  if (chunkRecords.length <= n)
    throw new Error(`this variant has ${chunkRecords.length} chunks`);
  const last = chunkRecords[n];
  return { bytes: bytes.slice(0, last.offset + last.length), chunkIndex: n };
}

/**
 * Append one legal private record whose arbitrary payload happens to end in file magic.
 *
 * It is not a Footer and there is no trailing marker after it. A marker-only completeness
 * probe therefore gets a false positive, while a structural terminal check does not.
 */
export function appendPrivateRecordEndingMagic(bytes) {
  const content = new Uint8Array(4 + MAGIC.length);
  content.set([0xde, 0xad, 0xbe, 0xef]);
  content.set(MAGIC, 4);
  const framed = new Uint8Array(RECORD_HEADER_BYTES + content.length);
  framed[0] = 0x80;
  new DataView(framed.buffer).setBigUint64(1, BigInt(content.length), true);
  framed.set(content, RECORD_HEADER_BYTES);
  return join([bytes, framed]);
}
