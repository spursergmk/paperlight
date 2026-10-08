import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// pdf.js paints asynchronously; when a canvas operation fails after its render
// task was replaced (zooming or switching tabs mid-render), Blink raises a bare
// `UnknownVizError` outside any promise we own. Swallowing exactly that case
// keeps the app alive — the page itself retries and reports its own error state.
window.addEventListener('unhandledrejection', (event) => {
  const name = (event.reason as { name?: string } | null)?.name
  if (name === 'UnknownVizError') {
    event.preventDefault()
    console.warn('[paperlight] recovered from a canvas paint error')
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
