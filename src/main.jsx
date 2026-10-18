import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Vite resolves this flag at build time. Public builds never load the local
// workspace, its saved ChatGPT accounts, or its cloud/auth initialization.
// eslint-disable-next-line react-refresh/only-export-components -- The application entry mounts the selected lazy root.
const Root = lazy(() => import.meta.env.VITE_LANDWISE_HOSTED === 'true'
  ? import('./App.jsx')
  : import.meta.env.VITE_LANDWISE_PUBLIC_PREVIEW === 'true'
  ? import('./components/PublicLaunch.jsx')
  : import('./App.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Suspense fallback={<p role="status" style={{ padding: '32px', fontFamily: 'Arial, sans-serif' }}>Opening Landwise…</p>}>
      <Root />
    </Suspense>
  </StrictMode>,
)
