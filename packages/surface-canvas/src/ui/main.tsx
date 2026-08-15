/**
 * FanOS Surface Canvas — iframe entry.
 *
 * Owns nothing but the view. Every fact on screen arrived over postMessage from
 * the sandbox; every action leaves the same way. That split is why the panel can
 * be re-laid-out without touching a rule.
 */
import type { JSX } from "react";
import { StrictMode, useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginMessage, UiMessage } from "../protocol.js";
import { App } from "./App.js";
import { initialState, reduce } from "./state.js";

/**
 * The boot handshake is a race: this iframe mounts while the sandbox is still
 * awaiting clientStorage, and either side can get there first. The sandbox
 * replays its whole boot payload on every `ui-ready`, so asking again is all it
 * takes to recover — and asking is cheap next to a panel stuck on "Starting…"
 * with an empty theme picker.
 */
const HANDSHAKE_RETRY_MS = 700;
const HANDSHAKE_MAX_RETRIES = 5;

export function send(message: UiMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function Root(): JSX.Element {
  // One reducer for both halves of the panel's state. A sandbox message and a
  // click that opens a card are the same kind of event as far as the panel is
  // concerned, and running them through one function is what keeps "a bind
  // closes its card and clears its skip" a fact you can test rather than an
  // effect somebody has to remember to write.
  const [state, dispatch] = useReducer(reduce, initialState);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = (event.data as { pluginMessage?: PluginMessage } | undefined)?.pluginMessage;
      if (!message) return;
      dispatch(message);
    };
    window.addEventListener("message", onMessage);
    send({ type: "ui-ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (state.booted || attempts >= HANDSHAKE_MAX_RETRIES) return;
    const retry = window.setTimeout(() => {
      send({ type: "ui-ready" });
      setAttempts((n) => n + 1);
    }, HANDSHAKE_RETRY_MS);
    return () => window.clearTimeout(retry);
  }, [state.booted, attempts]);

  // Out of retries and still nothing. Say so, rather than leaving a spinner that
  // means "working" when it actually means "broken".
  const stalled = !state.booted && attempts >= HANDSHAKE_MAX_RETRIES;

  return <App state={state} dispatch={dispatch} stalled={stalled} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
