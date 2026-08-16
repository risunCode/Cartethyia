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
const storedToken = localStorage.getItem('sessionToken')
const storedUser = localStorage.getItem('sessionUser')

// Global signals
const [theme, setTheme] = createSignal<Theme>(storedTheme || 'system')
const [sidebarCollapsed, setSidebarCollapsed] = createSignal<boolean>(storedSidebarCollapsed)
const [userSession, setUserSession] = createSignal<UserSession>({
  token: storedToken || null,
  user: storedUser ? JSON.parse(storedUser) : null,
})

// Persist theme to localStorage
createEffect(() => {
  localStorage.setItem('theme', theme())
})

// Persist sidebar collapsed to localStorage
createEffect(() => {
  localStorage.setItem('sidebarCollapsed', sidebarCollapsed().toString())
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
export { theme, setTheme, sidebarCollapsed, setSidebarCollapsed, userSession, setUserSession }
