/**
 * P1-11: the page a phone opens from the QR code in the photo-import dialog (`/?phone=<slot>`). One button: take or
 * choose a photo; it is sent to the dialog waiting on the computer. Nothing of the editor is shown or needed here.
 */
import { useRef, useState } from 'react'
import logo from '../ui/assets/brush-logo.png'
import { sendPhoto } from './phoneRelay'

type Phase = { kind: 'pick' } | { kind: 'sending'; name: string } | { kind: 'sent'; name: string } | { kind: 'error'; message: string }

export function PhoneUpload({ slot }: { slot: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })

  const send = async (file: File) => {
    setPhase({ kind: 'sending', name: file.name })
    try {
      await sendPhoto(slot, file)
      setPhase({ kind: 'sent', name: file.name })
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message || String(e) })
    }
  }

  return (
    <main className="phone-upload" data-testid="phone-upload" data-phase={phase.kind}>
      <img className="phone-logo" src={logo} alt="Brush" />
      <h1>Send a photo of your markup</h1>
      <p>Photograph the printed sheet flat and in focus, with all of the markup in the picture. It goes straight to the import dialog on your computer.</p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        data-testid="phone-file"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void send(f)
        }}
      />
      {phase.kind === 'sending' ? (
        <p className="phone-status" aria-live="polite">
          Sending {phase.name}…
        </p>
      ) : (
        <button type="button" className="btn accent phone-pick" data-testid="phone-pick" onClick={() => input.current?.click()}>
          {phase.kind === 'sent' ? 'Send another photo' : 'Take or choose a photo'}
        </button>
      )}
      {phase.kind === 'sent' && (
        <p className="phone-status ok" role="status" data-testid="phone-sent">
          Sent. Look at your computer: the photo is in the import dialog.
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="phone-status error" role="alert" data-testid="phone-error">
          {phase.message}
        </p>
      )}
    </main>
  )
}
