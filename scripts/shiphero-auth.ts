/**
 * Sign in to ShipHero and store a scoped, read-only token for the sync.
 *
 *   railway run --service Postgres -- pnpm shiphero:auth
 *     (with SHIPHERO_TOKEN_KEY in the environment — see CLAUDE.md)
 *
 * OAuth 2.0 Authorization Code + PKCE (developer.shiphero.com/scopes), on
 * this machine: ShipHero redirects to http://localhost:3000/callback, so
 * port 3000 must be free. Asks for openid profile offline_access view:orders
 * view:shipments view:billing — no view:pii, no change: scope.
 *
 * If ShipHero grants anything other than that, or withholds view:billing, it
 * stops, revokes what was issued and stores nothing. On success the tokens
 * are written encrypted to shiphero_tokens. No token is ever printed.
 */

import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { createDb } from "@/db/client";
import { parseTokenKey, saveTokens } from "@/db/shiphero-tokens";
import { authorizeUrl, completeSignIn, createPkce, randomState, SHIPHERO_SCOPES } from "@/integrations/shiphero-auth";

const TIMEOUT_MS = 5 * 60_000;

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function main() {
  const keyText = process.env.SHIPHERO_TOKEN_KEY;
  if (!keyText) fail("SHIPHERO_TOKEN_KEY is not set. It must be the same key the worker has.");
  const key = parseTokenKey(keyText);
  // Off Railway the internal URL does not resolve; the Postgres service gives the public one.
  const databaseUrl = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) fail("No DATABASE_PUBLIC_URL or DATABASE_URL. Run this under `railway run --service Postgres`.");

  const { verifier, challenge } = createPkce();
  const state = randomState();

  const params = await new Promise<URLSearchParams>((resolve, reject) => {
    const servers: Server[] = [];
    const close = () => servers.forEach((s) => s.close());
    const timer = setTimeout(() => {
      close();
      reject(new Error("No sign-in within 5 minutes."));
    }, TIMEOUT_MS);
    const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost:3000");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<p>Received. You can close this tab and return to the terminal.</p>");
      clearTimeout(timer);
      close();
      resolve(url.searchParams);
    };
    // Loopback only, on both address families a browser may use for "localhost".
    let listening = 0;
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handler);
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          clearTimeout(timer);
          close();
          reject(new Error(`Port 3000 is in use on ${host} (a dev server?). Stop it and run this again.`));
        } else if (err.code !== "EADDRNOTAVAIL" && err.code !== "EAFNOSUPPORT") {
          reject(err);
        }
      });
      server.listen(3000, host, () => {
        if (++listening === 1) {
          const url = authorizeUrl({ challenge, state });
          console.log(`Requesting scopes: ${SHIPHERO_SCOPES.join(" ")}`);
          console.log("Opening ShipHero's sign-in in your browser. If it does not open, visit:\n");
          console.log(url);
          console.log("\nWaiting for you to approve (5 minutes)...");
          spawn("open", [url], { stdio: "ignore", detached: true }).on("error", () => {});
        }
      });
      servers.push(server);
    }
  }).catch((err) => fail(err instanceof Error ? err.message : String(err)));

  const result = await completeSignIn({ params, expectedState: state, verifier }).catch((err) => fail(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`));
  if (!result.ok) {
    fail(
      `Not stored. ${result.reason}` +
        (result.granted && result.granted.length > 0 ? `\n  Granted: ${result.granted.join(" ")}` : "") +
        (result.revoked === undefined ? "" : result.revoked ? "\n  The token ShipHero issued has been revoked." : "\n  Revoking the issued token FAILED — revoke it in ShipHero."),
    );
  }

  const expiresAt = new Date(Date.now() + result.tokens.expiresInSeconds * 1000);
  const db = createDb(databaseUrl);
  await saveTokens(db, key, { accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken, expiresAt, scope: result.tokens.scope }, { refreshed: false });
  console.log(`\n✓ Signed in. Stored encrypted in shiphero_tokens.`);
  console.log(`  Granted: ${result.granted.join(" ")}`);
  console.log(`  Access token expires ${expiresAt.toISOString().slice(0, 10)}; the worker refreshes it before then.`);
  process.exit(0);
}

main();
