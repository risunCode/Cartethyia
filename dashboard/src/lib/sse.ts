import { createSignal, onCleanup, createEffect } from 'solid-js'
import { userSession } from './store'

// SSE event types
interface SSEEvent {
  type: string
  data: Record<string, unknown> | string
}

// SSE connection state
interface SSEConnectionState {
  connected: boolean
  reconnecting: boolean
  error: string | null
}

// SSE hook options
interface SSEOptions {
  onMessage?: (event: SSEEvent) => void
  onError?: (error: Error) => void
  onConnect?: () => void
  onDisconnect?: () => void
  reconnectInterval?: number // Base reconnect interval in ms (default 3000ms)
  maxReconnectAttempts?: number
  /** Named SSE event types to subscribe to (the default message channel stays active). */
  events?: string[]
}

// Connection pool for single connection per page
const connectionPool = new Map<string, EventSource>()

// useSSE hook
export function useSSE(url: string, options: SSEOptions = {}) {
  const {
    onMessage,
    onError,
    onConnect,
    onDisconnect,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
    events = [],
  } = options

  const [state, setState] = createSignal<SSEConnectionState>({
    connected: false,
    reconnecting: false,
    error: null,
  })

  let eventSource: EventSource | null = null
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Calculate exponential backoff
  function getBackoffInterval(): number {
    return Math.min(reconnectInterval * Math.pow(2, reconnectAttempts), 30000) // Max 30s
  }

  // Connect to SSE endpoint
  function connect() {
    // Check if connection already exists in pool
    if (connectionPool.has(url)) {
      eventSource = connectionPool.get(url) as EventSource
      setState(prev => ({ ...prev, connected: true }))
      onConnect?.()
      return
    }

    // Add auth token to URL if available
    const session = userSession()
    const urlWithToken = session.token
      ? `${url}${url.includes('?') ? '&' : '?'}token=${session.token}`
      : url

    // Create new EventSource connection
    eventSource = new EventSource(urlWithToken)

    // Add to connection pool
    connectionPool.set(url, eventSource)

    // Connection opened
    eventSource.onopen = () => {
      setState(prev => ({ ...prev, connected: true, reconnecting: false, error: null }))
      reconnectAttempts = 0
      onConnect?.()
    }

    // Handle incoming messages: the default channel plus any named event
    // types requested via `events` (e.g. the daemon's share "count" events).
    const dispatch = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(event.data) as SSEEvent
        onMessage?.(data)
      } catch (error) {
        console.error('Failed to parse SSE event:', error)
        onError?.(error as Error)
      }
    }
    eventSource.onmessage = dispatch
    for (const type of events) {
      eventSource.addEventListener(type, dispatch as EventListener)
    }

    // Handle errors
    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error)
      setState(prev => ({ ...prev, connected: false, error: 'Connection failed' }))
      onDisconnect?.()
      onError?.(new Error('SSE connection error'))

      // Auto-reconnect with exponential backoff
      if (reconnectAttempts < maxReconnectAttempts) {
        setState(prev => ({ ...prev, reconnecting: true }))
        const backoff = getBackoffInterval()
        reconnectTimer = setTimeout(() => {
          reconnectAttempts++
          connect()
        }, backoff)
      }
    }
  }

  // Disconnect from SSE endpoint
  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (eventSource) {
      eventSource.close()
      eventSource = null
      connectionPool.delete(url)
    }

    setState(prev => ({ ...prev, connected: false, reconnecting: false }))
    onDisconnect?.()
  }

  // Connect on mount
  createEffect(() => {
    connect()

    // Cleanup on unmount
    onCleanup(() => {
      disconnect()
    })
  })

  // Return state and control functions
  return {
    state,
    connect,
    disconnect,
    reconnect: () => {
      disconnect()
      setTimeout(connect, 100)
    },
  }
}

// Helper function to close all SSE connections (for page navigation)
export function closeAllSSEConnections() {
  for (const [url, eventSource] of connectionPool.entries()) {
    eventSource.close()
    connectionPool.delete(url)
  }
}

// Helper function to get connection pool status (for monitoring)
export function getSSEConnectionPoolStatus(): Array<{ url: string; connected: boolean }> {
  return Array.from(connectionPool.entries()).map(([url, eventSource]) => ({
    url,
    connected: eventSource.readyState === EventSource.OPEN,
  }))
}
