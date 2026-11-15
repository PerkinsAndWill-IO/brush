/**
 * M6-08: a page served over https (the Vercel deployment) meets Chrome's local-network prompt and Revit's origin
 * dialog. The panel explains them before the first connect, and nothing reaches for 127.0.0.1 on its own (M6-11
 * auto-connect, health probes) until the user has read that once.
 */
const LNA_ACK_KEY = 'brush.revit.lnaExplained'

export function needsExplainer(): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return false
  try {
    return localStorage.getItem(LNA_ACK_KEY) !== '1'
  } catch {
    return true
  }
}

export function ackExplainer() {
  try {
    localStorage.setItem(LNA_ACK_KEY, '1')
  } catch {
    /* private mode: ask again next time */
  }
}
