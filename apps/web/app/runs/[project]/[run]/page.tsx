/**
 * Live view of one pipeline run.
 *
 * A server shell around a client subscription. The shell renders no progress
 * itself — there is nothing to hydrate and nothing to keep in sync, because the
 * progress lives in Postgres and streams to the client directly.
 */
import { LiveRun } from "./live-run";

/** Browser-side base URL for the control plane. */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default async function RunPage({
  params,
}: {
  params: Promise<{ project: string; run: string }>;
}) {
  const { project, run } = await params;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#050505",
        padding: 40,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 720 }}>
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            opacity: 0.5,
            color: "#ddd",
            marginBottom: 12,
          }}
        >
          {project} / {run}
        </div>
        <LiveRun apiUrl={API_URL} project={project} run={run} />
      </div>
    </main>
  );
}
