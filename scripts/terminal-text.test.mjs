// Unit tests for the pure text policy in web/terminal-text.js -- the single
// choke point between the faithfully forwarded input (the hidden field keeps
// whatever the IME produced) and the one-byte-per-character engine buffer.
// The contract, per transformation stage in toEngineText:
//
//   - composed input never vanishes: Vietnamese Telex "a"+"s" arrives as á,
//     dead keys arrive as their accented result, and both must yield the
//     BASE letter (the bug this replaces stripped the composed character and
//     deleted the letter under it);
//   - Vietnamese đ/Đ never NFD-decomposes (the stroke is part of the glyph)
//     and maps by hand;
//   - iOS Smart Punctuation's curly quotes map back to ASCII (blue24), so
//     contractions survive;
//   - CJK, emoji, and symbols drop, as they always have;
//   - the result is upper case, and its length never exceeds the input's
//     (a line capped at maxInputLength before the call stays within the
//     keys buffer after it).
//
//   node --test scripts/terminal-text.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { toEngineText } from "../web/terminal-text.js";

test("plain ascii passes through upper-cased", () => {
  assert.equal(toEngineText("look"), "LOOK");
  assert.equal(toEngineText("GET LAMP"), "GET LAMP");
  assert.equal(toEngineText(""), "");
});

test("composed accents yield the base letter, not nothing", () => {
  // Vietnamese Telex: "a"+"s" -> á, "o"+"o" -> ô.
  assert.equal(toEngineText("á"), "A");
  assert.equal(toEngineText("loôk"), "LOOK");
  assert.equal(toEngineText("wás"), "WAS");
  // European dead keys.
  assert.equal(toEngineText("ü"), "U");
  assert.equal(toEngineText("é"), "E");
  assert.equal(toEngineText("ç"), "C");
});

test("precomposed and decomposed accents agree", () => {
  assert.equal(toEngineText("é"), toEngineText("e\u0301"));
  assert.equal(toEngineText("Á"), toEngineText("A\u0301"));
});

test("vietnamese đ maps to d in both cases", () => {
  assert.equal(toEngineText("đ"), "D");
  assert.equal(toEngineText("Đ"), "D");
  assert.equal(toEngineText("dd"), "DD");
});

test("curly quotes map back to ascii", () => {
  assert.equal(toEngineText("don\u2019t"), "DON'T");
  assert.equal(toEngineText("\u2018x\u2018 \u201Cy\u201D"), "'X' \"Y\"");
});

test("cjk, emoji, and symbols drop", () => {
  assert.equal(toEngineText("冒険"), "");
  assert.equal(toEngineText("🎉"), "");
  assert.equal(toEngineText("café ☕"), "CAFE ");
});

test("length never grows for upper-cased input", () => {
  // ß upper-cases to SS, so the guarantee holds for input that is already
  // upper case -- the shape liveInputText() always delivers.
  const upper = "Ü Ö Ä ß ÁÉÍÓÚ ĐŁ Ø Æ ß".toUpperCase();
  const out = toEngineText(upper);
  assert.ok(out.length <= upper.length, `${out.length} > ${upper.length}`);
});
