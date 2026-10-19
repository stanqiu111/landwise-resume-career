import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// App selects hosted or loopback behavior through VITE_LANDWISE_HOSTED.
// eslint-disable-next-line react-refresh/only-export-components -- The application entry mounts the selected lazy root.
const Root = lazy(() => import('./App.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={<p role="status" style={{ padding: '32px', fontSize: 'var(--text-sm)' }}>Opening Landwise…</p>}>
      <Root />
    </Suspense>
  </StrictMode>,
)
