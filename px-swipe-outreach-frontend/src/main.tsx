import React from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'
import { resolveAuthConfig } from './auth/supabase'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Root config={resolveAuthConfig()} /></React.StrictMode>,
)
