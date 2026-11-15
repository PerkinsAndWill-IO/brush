/**
 * P1-11: the QR code in the photo-import dialog. Scanning it opens the phone page (./PhoneUpload.tsx) for a new slot;
 * the photo sent from there arrives here and becomes the dialog's photo.
 */
import { useEffect, useState } from 'react'
import { encode } from 'uqr'
import { dropSlot, isLocalOrigin, newSlotId, phoneLink, relayAvailable, waitForPhoto } from './phoneRelay'

type State = { kind: 'checking' } | { kind: 'local' } | { kind: 'unavailable' } | { kind: 'waiting'; link: string; reconnecting?: boolean } | { kind: 'error'; message: string }

/** The QR code as SVG squares (no markup injected). */
function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { ecc: 'M', border: 2 })
  let d = ''
  data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)))
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code: open it on your phone to send a photo" data-testid="photo-qr" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#1b1d21" />
    </svg>
  )
}

export function PhoneQr({ onPhoto }: { onPhoto: (file: File) => void }) {
  const [state, setState] = useState<State>({ kind: 'checking' })
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (isLocalOrigin(location.hostname)) return setState({ kind: 'local' })
    const ac = new AbortController()
    const slot = newSlotId()
    let received = false
    void (async () => {
      if (!(await relayAvailable())) return !ac.signal.aborted && setState({ kind: 'unavailable' })
      if (ac.signal.aborted) return
      setState({ kind: 'waiting', link: phoneLink(location.origin, slot) })
      try {
        const link = phoneLink(location.origin, slot)
        const file = await waitForPhoto(slot, ac.signal, undefined, (connected) => !ac.signal.aborted && setState({ kind: 'waiting', link, reconnecting: !connected }))
        received = true
        onPhoto(file)
      } catch (e) {
        if (!ac.signal.aborted) setState({ kind: 'error', message: (e as Error).message || String(e) })
      }
    })()
    return () => {
      ac.abort()
      if (!received) dropSlot(slot)
    }
    // a new slot per round only; onPhoto may change identity without needing a new code
  }, [round])

  return (
    <div className="phone-qr" data-testid="photo-phone-panel" data-state={state.kind}>
      {state.kind === 'checking' && <p className="secondary">Preparing a code…</p>}
      {state.kind === 'local' && (
        <p className="secondary">
          A phone cannot reach this computer's own address (localhost). Open Brush at its web address to send photos from your phone.
        </p>
      )}
      {state.kind === 'unavailable' && <p className="secondary">Sending photos from a phone is not set up on this server.</p>}
      {state.kind === 'waiting' && (
        <>
          <QrCode text={state.link} />
          <p className="secondary">
            Scan with your phone's camera, then take or choose the photo there. It appears here by itself. The code works once, for 15 minutes.
          </p>
          {state.reconnecting && (
            <p className="secondary" role="status" data-testid="photo-phone-reconnecting">
              Connection lost. Reconnecting… The code still works, and a photo sent meanwhile will arrive.
            </p>
          )}
        </>
      )}
      {state.kind === 'error' && (
        <>
          <p className="error-text" role="alert">
            {state.message}
          </p>
          <button type="button" className="btn soft" onClick={() => setRound((r) => r + 1)}>
            Show a new code
          </button>
        </>
      )}
    </div>
  )
}
