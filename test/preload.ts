/**
 * Test preload — runs before all test files.
 * Sets environment defaults so tests don't need to configure auth mode.
 */
Bun.env.PROXY_AUTH_MODE = "open";
