import { createSignal, createEffect } from 'solid-js'

// Theme types
type Theme = 'light' | 'dark' | 'system'

// User session types
interface UserSession {
  token: string | null
  user: Record<string, unknown> | null
}

// Initialize signals from localStorage
const storedTheme = localStorage.getItem('theme') as Theme
const storedSidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true'
const storedGlassSurfaces = localStorage.getItem('glassSurfaces') === 'true'
const storedToken = localStorage.getItem('sessionToken')
const storedUser = localStorage.getItem('sessionUser')

// Global signals
const [theme, setTheme] = createSignal<Theme>(storedTheme || 'system')
const [sidebarCollapsed, setSidebarCollapsed] = createSignal<boolean>(storedSidebarCollapsed)
const [glassSurfaces, setGlassSurfaces] = createSignal<boolean>(storedGlassSurfaces)
// Mobile off-canvas navigation (never persisted — starts closed).
const [mobileNavOpen, setMobileNavOpen] = createSignal<boolean>(false)
const [userSession, setUserSession] = createSignal<UserSession>({
  token: storedToken || null,
  user: storedUser ? JSON.parse(storedUser) : null,
})

// Resolve 'system' against the OS preference (jsdom has no matchMedia).
const systemPrefersDark =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

const applyDocumentTheme = () => {
  const current = theme()
  const effective =
    current === 'system' ? (systemPrefersDark?.matches ? 'dark' : 'light') : current
  document.documentElement.classList.toggle('dark', effective === 'dark')
}

// Apply theme + surface mode to the document root (this is what actually
// flips the .dark class and the data-glass attribute the CSS keys off).
createEffect(applyDocumentTheme)
systemPrefersDark?.addEventListener('change', applyDocumentTheme)

createEffect(() => {
  document.documentElement.dataset.glass = glassSurfaces() ? 'on' : 'off'
})

// Persist theme to localStorage
createEffect(() => {
  localStorage.setItem('theme', theme())
})

// Persist sidebar collapsed to localStorage
createEffect(() => {
  localStorage.setItem('sidebarCollapsed', sidebarCollapsed().toString())
})

// Persist glass surface mode to localStorage
createEffect(() => {
  localStorage.setItem('glassSurfaces', glassSurfaces().toString())
})

// Persist session to localStorage
createEffect(() => {
  const session = userSession()
  if (session.token) {
    localStorage.setItem('sessionToken', session.token)
  } else {
    localStorage.removeItem('sessionToken')
  }

  if (session.user) {
    localStorage.setItem('sessionUser', JSON.stringify(session.user))
  } else {
    localStorage.removeItem('sessionUser')
  }
})

// Session management functions
export function login(token: string, user: Record<string, unknown>) {
  setUserSession({ token, user })
}

export function logout() {
  setUserSession({ token: null, user: null })
}

export function refreshToken(newToken: string) {
  setUserSession(prev => ({ ...prev, token: newToken }))
}

// Export signals and setters
export { theme, setTheme, sidebarCollapsed, setSidebarCollapsed, glassSurfaces, setGlassSurfaces, mobileNavOpen, setMobileNavOpen, userSession, setUserSession }
