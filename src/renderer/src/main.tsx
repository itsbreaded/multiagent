import './assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { defaultTheme, installTheme } from './styles/theme'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

installTheme(defaultTheme)

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
