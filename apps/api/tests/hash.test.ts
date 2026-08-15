import { describe, expect, it } from "vitest";

import { canonicalJson, digestOf, digestOfJson, isDigest } from "../src/kernel/hash.js";

describe("canonicalJson", () => {
  it("sorts keys so key order cannot change the digest", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("drops undefined values rather than emitting them", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("leaves null alone — null is a value, undefined is an absence", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});

describe("digestOfJson", () => {
  it("gives structurally identical trees one identity", () => {
    const a = { nodes: [{ id: "root", type: "box" }], schemaVersion: 1 };
    const b = { schemaVersion: 1, nodes: [{ type: "box", id: "root" }] };
    expect(digestOfJson(a)).toBe(digestOfJson(b));
  });

  it("separates trees that differ", () => {
    expect(digestOfJson({ a: 1 })).not.toBe(digestOfJson({ a: 2 }));
  });
});

describe("digestOf", () => {
  it("is sha256 hex", () => {
    // Well-known vector, so a swapped algorithm shows up immediately.
    expect(digestOf(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("isDigest", () => {
  it("accepts 64 lowercase hex chars", () => {
    expect(isDigest("a".repeat(64))).toBe(true);
  });

  it("rejects uuids, short strings and uppercase", () => {
    expect(isDigest("A".repeat(64))).toBe(false);
    expect(isDigest("a".repeat(63))).toBe(false);
    expect(isDigest("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(false);
  });
});
