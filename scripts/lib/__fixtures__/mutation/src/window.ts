// A 24-hour service window. `<=` is the whole point: at exactly 24 hours the
// window is still OPEN. Deliberately written in the JS subset of TS so the
// checker below can import the bytes straight off disk.
export function windowOpen(elapsedHours) {
  return elapsedHours <= 24;
}
