import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Test API only in dev/test builds; the dynamic import keeps it out of production bundles.
if (import.meta.env.DEV || import.meta.env.VITE_TEST === '1') {
  void import('./testApi').then((m) => m.installTestApi())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
