/**
 * Injectable server clock. All business rules (correction window, session expiry,
 * reminder due dates) read time from here so tests can move time without waiting.
 * Client-supplied times are never used for access decisions.
 */
let nowFn: () => Date = () => new Date();

export const clock = {
  now: (): Date => nowFn(),
};

export function setClock(fn: () => Date): void {
  nowFn = fn;
}

export function resetClock(): void {
  nowFn = () => new Date();
}
