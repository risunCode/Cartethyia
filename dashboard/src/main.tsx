import { render } from 'solid-js/web'
import './styles/index.css'
import App from './App'
import { reportError } from './lib/error-reporter'

window.addEventListener('error', (event) => {
  reportError('error', event.message, { filename: event.filename, lineno: event.lineno })
})
window.addEventListener('unhandledrejection', (event) => {
  reportError('error', String(event.reason))
})

render(() => <App />, document.getElementById('root') as HTMLElement)
