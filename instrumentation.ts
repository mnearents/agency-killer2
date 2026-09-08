/**
 * Next.js startup hook — runs once when the web server boots.
 *
 * Exists only to report this process's environment. The web app is the third
 * surface in the env manifest, and a surface that never reports shows up in
 * `data_freshness` as unknown forever, which would be a permanent warning
 * rather than a signal.
 */

import { checkEnv, formatEnvCheck } from "@/lib/env-check";

const DAY_MS = 24 * 60 * 60 * 1000;

async function report(): Promise<void> {
  const result = checkEnv("web", process.env, new Date());
  for (const line of formatEnvCheck(result)) console.log(line);

  try {
    // Imported lazily: this file is also evaluated during `next build`, where
    // there is no database to connect to and nothing worth recording.
    const { db } = await import("@/lib/db");
    const { recordEnvCheck } = await import("@/db/env-status");
    await recordEnvCheck(db(), result);
  } catch (err) {
    // Fails closed on its own: with no record the surface reads as unknown,
    // which `data_freshness` already reports as a problem. Not worth refusing
    // to serve pages over.
    console.error("[env] Could not record the environment check:", err);
  }
}

export async function register(): Promise<void> {
  // The edge runtime has neither the database driver nor the variables.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  await report();

  // Repeat daily, so `checked_at` reports liveness rather than boot time — a
  // record that stops advancing is a process that stopped running. `unref` so
  // this never keeps the process alive on its own.
  setInterval(() => void report(), DAY_MS).unref();
}
