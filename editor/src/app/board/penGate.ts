/**
 * Ink has priority over page rendering: while the pen is down, pdf.js render
 * chunks (main-thread canvas work) wait until pen-up, so they never delay ink.
 */
let down = false
let waiters: (() => void)[] = []

export function setPenDown(v: boolean) {
  down = v
  if (!v) {
    const w = waiters
    waiters = []
    w.forEach((r) => r())
  }
}

/** null when free; otherwise a promise that resolves at pen-up. */
export function penGate(): Promise<void> | null {
  return down ? new Promise((r) => waiters.push(r)) : null
}
