import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

declare global {
  interface Window { EXCALIDRAW_ASSET_PATH?: string }
}

window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
