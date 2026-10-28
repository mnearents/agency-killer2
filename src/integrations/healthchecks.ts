/**
 * healthchecks.io heartbeat — the seam.
 *
 * A check expects a ping every period. A ping to `/fail` alerts at once; no
 * ping at all alerts once the grace time runs out. Between them that covers a
 * job that ran and failed and one that never ran.
 *
 * Pings never throw. A heartbeat that could take down the job it watches
 * would turn a healthchecks.io outage into ours; a failed ping is logged and
 * shows up on healthchecks.io as the missed ping it is.
 */

import type { Heartbeat } from "@/domain/meta/run-watch";

const TIMEOUT_MS = 10_000;

export function createHeartbeat(pingUrl: string | undefined): Heartbeat {
  if (!pingUrl) {
    const none = async () => undefined;
    return { configured: false, start: none, success: none, fail: none };
  }
  const base = pingUrl.replace(/\/+$/, "");

  const ping = async (url: string, body?: string) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        body: body ?? "",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) console.error(`[healthchecks] Ping to ${url} answered ${response.status}`);
    } catch (err) {
      console.error(`[healthchecks] Ping to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    configured: true,
    start: () => ping(`${base}/start`),
    success: () => ping(base),
    // healthchecks.io keeps up to 100KB of body; the reason is far shorter.
    fail: (message) => ping(`${base}/fail`, message.slice(0, 10_000)),
  };
}
