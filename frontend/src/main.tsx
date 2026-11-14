import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Leaflet's own stylesheet must come first: it carries the structural rules — pane
// stacking, the `.leaflet-container` box, the control layout — that our overrides in
// index.css then adjust. Loading it second would put its resets on top of ours.
import 'leaflet/dist/leaflet.css'
import './index.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found in index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
