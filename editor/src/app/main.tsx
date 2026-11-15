import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PhoneUpload } from './photo/PhoneUpload'
import './styles.css'

// Test API only in dev/test builds; the dynamic import keeps it out of production bundles.
if (import.meta.env.DEV || import.meta.env.VITE_TEST === '1') {
  void import('./testApi').then((m) => m.installTestApi())
}

// P1-11: a phone that scanned the photo-import QR code gets the upload page, not the editor
const phoneSlot = new URLSearchParams(location.search).get('phone')

createRoot(document.getElementById('root')!).render(<StrictMode>{phoneSlot ? <PhoneUpload slot={phoneSlot} /> : <App />}</StrictMode>)
