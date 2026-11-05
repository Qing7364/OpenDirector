type Key = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "repeat" | "isComposing">;
/** Only two short standalone Shift presses count; chords and held keys reset the gesture. */
export function doubleShiftDetector(clock = () => performance.now()) {
  let down: number | null = null;
  let previous: number | null = null;
  function reset() { down = previous = null; }
  return {
    reset,
    keydown(event: Key) {
      if (event.key !== "Shift" || event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing) {
        reset(); return;
      }
      if (down !== null) { reset(); return; }
      down = clock();
    },
    keyup(event: Key) {
      const now = clock();
      if (event.key !== "Shift" || down === null || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || now - down > 250) {
        reset(); return false;
      }
      down = null;
      if (previous !== null && now - previous <= 350) { reset(); return true; }
      previous = now;
      return false;
    },
  };
}
