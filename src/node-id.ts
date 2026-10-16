/**
 * Time-ordered node ids (UUIDv7, RFC 9562, with a monotonic counter in rand_a).
 *
 * Reads break ties "newest first, then by id". With random v4 ids, two facts written in the
 * same millisecond came back in random order and write order could not be recovered (issue #5).
 * A v7 id sorts by creation time and, within one millisecond, by write order — so the existing
 * byte-order tiebreak now settles same-millisecond ties the way they were written. Timestamps
 * are untouched: no fact is ever stamped in the future to make room.
 */
let lastMs = -1;
let seq = 0;

export function newNodeId(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    seq++;
    if (seq > 0xfff) { ms = lastMs + 1; seq = 0; }
  } else {
    seq = 0;
  }
  lastMs = ms;
  const rand = globalThis.crypto.getRandomValues(new Uint8Array(8));
  rand[0] = (rand[0]! & 0x3f) | 0x80; // RFC 9562 variant 10
  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
  const time = hex(ms, 12);
  const tail = Array.from(rand, (b) => hex(b, 2)).join("");
  return `${time.slice(0, 8)}-${time.slice(8)}-${hex(0x7000 | seq, 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}
