import assert from "node:assert/strict";
import test from "node:test";
import { doubleShiftDetector } from "../src/canvas/doubleShift.ts";
const key = (name = "Shift", extra = {}) => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, ...extra });
test("double Shift toggles once after two short released taps", () => {
  let now = 0;
  const detector = doubleShiftDetector(() => now);
  detector.keydown(key()); now = 50; assert.equal(detector.keyup(key()), false);
  now = 140; detector.keydown(key()); now = 190; assert.equal(detector.keyup(key()), true);
  assert.equal(detector.keyup(key()), false);
});
test("chords, long presses, composition and interruption do not trigger chat", () => {
  for (const interrupt of ["letter", "repeat", "compose", "pointer", "modifier", "long"]) {
    let now = 0;
    const detector = doubleShiftDetector(() => now);
    detector.keydown(key()); now = 30; detector.keyup(key());
    now = 70; detector.keydown(key());
    if (interrupt === "letter") detector.keydown(key("A"));
    if (interrupt === "repeat") detector.keydown(key("Shift", { repeat: true }));
    if (interrupt === "compose") detector.keydown(key("Shift", { isComposing: true }));
    if (interrupt === "pointer") detector.reset();
    if (interrupt === "modifier") detector.keydown(key("Control", { ctrlKey: true }));
    now = interrupt === "long" ? 400 : 100;
    assert.equal(detector.keyup(key()), false, interrupt);
  }
});
