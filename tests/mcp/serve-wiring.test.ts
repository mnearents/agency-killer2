import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The hosted entry point is a socket and a process, so it is not run here.
 * These assert its call sites: a handler and verifier that are fully tested
 * but never wired in would leave an open endpoint that looks protected.
 */
const source = readFileSync(join(__dirname, "../../src/mcp/serve.ts"), "utf-8");

describe("hosted MCP entry point", () => {
  it("answers every request through the authenticated handler", () => {
    expect(source).toMatch(/const handler = createHostedHandler\(/);
    expect(source).toMatch(/await handler\(req\)/);
  });

  it("verifies tokens against AuthKit's published keys", () => {
    expect(source).toMatch(/verify: createTokenVerifier\(auth, createRemoteJWKSet\(new URL\(`\$\{auth\.authServer\}\/oauth2\/jwks`\)\)/);
  });

  it("refuses to start without login configured", () => {
    const block = source.slice(source.indexOf("if (!parsed.ok) {"), source.indexOf("const auth = parsed.config"));
    expect(block, "no refusal block before the config is used").toMatch(/process\.exit\(1\)/);
  });

  // The segment push reaches Attentive. It stays on the local server.
  it("never builds an Attentive client", () => {
    expect(source).not.toMatch(/createAttentiveWriteClient|attentive:/);
  });

  it("builds requests on the configured public URL, not the Host header", () => {
    expect(source).toMatch(/new URL\(nodeReq\.url \?\? "\/", auth\.publicUrl\)/);
  });
});
