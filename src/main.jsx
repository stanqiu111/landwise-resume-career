import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/barlow-condensed/800.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import './index.css'

// App selects hosted or loopback behavior through VITE_LANDWISE_HOSTED.
// eslint-disable-next-line react-refresh/only-export-components -- The application entry mounts the selected lazy root.
const Root = lazy(() => import('./App.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={<p role="status" style={{ padding: '32px', fontSize: 'var(--text-sm)', color: '#f5f1e6' }}>Opening Landwise…</p>}>
      <Root />
    </Suspense>
  </StrictMode>,
)
