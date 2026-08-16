/**
 * Surface Studio holds no state. It is a forwarder, and this is everything it
 * needs to reach the control plane.
 *
 * The API key lives here, server-side, and is never sent to the browser. That
 * is the whole reason the board's sync goes back through this process instead
 * of the browser calling the API directly: a key in a bundle is a published
 * key.
 */
export interface StudioConfig {
  apiUrl: string;
  apiKey: string | null;
  /** Which project the board shows. Exports resolve their own tenant by file key. */
  projectRef: string;
}

export function loadStudioConfig(env: NodeJS.ProcessEnv = process.env): StudioConfig {
  return {
    apiUrl: (env.FANOS_API_URL ?? "http://localhost:4000").replace(/\/+$/, ""),
    apiKey: env.FANOS_API_KEY?.trim() || null,
    projectRef: env.FANOS_PROJECT ?? "default",
  };
}

export function authHeaders(config: StudioConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
}
