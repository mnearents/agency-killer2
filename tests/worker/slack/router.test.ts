import { describe, it, expect } from "vitest";
import {
  parseMessage,
  routeCommand,
  type ParsedCommand,
} from "@/worker/slack/router";

// ─── Message parsing ──────────────────────────────────────────────────

describe("parseMessage: structured commands", () => {
  it("parses '!ads report' as ads command with report action", () => {
    const result = parseMessage("!ads report");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("ads");
      expect(result.action).toBe("report");
    }
  });

  it("parses '!email design summer sale' with args", () => {
    const result = parseMessage("!email design summer sale");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("email");
      expect(result.action).toBe("design");
      expect(result.args).toBe("summer sale");
    }
  });

  it("parses '!blog create' as blog command", () => {
    const result = parseMessage("!blog create");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("blog");
      expect(result.action).toBe("create");
    }
  });

  it("parses '!social analyze' as social command", () => {
    const result = parseMessage("!social analyze");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("social");
      expect(result.action).toBe("analyze");
    }
  });

  it("parses '!inventory check' as inventory command", () => {
    const result = parseMessage("!inventory check");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("inventory");
      expect(result.action).toBe("check");
    }
  });

  it("parses '!help' as help command with empty action", () => {
    const result = parseMessage("!help");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("help");
    }
  });

  it("parses unknown command category as 'unknown'", () => {
    const result = parseMessage("!foobar something");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("unknown");
    }
  });

  it("is case-insensitive for category", () => {
    const result = parseMessage("!ADS Report");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("ads");
      expect(result.action).toBe("report");
    }
  });

  it("trims whitespace", () => {
    const result = parseMessage("  !ads   report  ");
    expect(result.type).toBe("command");
    if (result.type === "command") {
      expect(result.category).toBe("ads");
      expect(result.action).toBe("report");
    }
  });

  it("preserves raw message", () => {
    const result = parseMessage("!ads report last week");
    expect(result.raw).toBe("!ads report last week");
  });
});

describe("parseMessage: natural language", () => {
  it("routes non-command messages as natural language", () => {
    const result = parseMessage("How are my ads doing?");
    expect(result.type).toBe("natural");
    if (result.type === "natural") {
      expect(result.text).toBe("How are my ads doing?");
    }
  });

  it("treats messages without ! prefix as natural language", () => {
    const result = parseMessage("What should I shoot next for reels?");
    expect(result.type).toBe("natural");
  });

  it("handles empty message as natural language", () => {
    const result = parseMessage("");
    expect(result.type).toBe("natural");
  });

  it("preserves raw message", () => {
    const result = parseMessage("How are my ads doing?");
    expect(result.raw).toBe("How are my ads doing?");
  });
});

// ─── Command routing ──────────────────────────────────────────────────

describe("routeCommand: maps commands to handlers", () => {
  it("routes ads report to meta analysis handler", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "ads",
      action: "report",
      args: "",
      raw: "!ads report",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("meta:analysis");
  });

  it("routes ads status to meta status handler", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "ads",
      action: "status",
      args: "",
      raw: "!ads status",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("meta:status");
  });

  it("routes email design to email creative handler with args", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "email",
      action: "design",
      args: "summer sale promo",
      raw: "!email design summer sale promo",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("email:design");
    expect(result.params.brief).toBe("summer sale promo");
  });

  it("routes blog create to blog generation handler", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "blog",
      action: "create",
      args: "planner organization tips",
      raw: "!blog create planner organization tips",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("blog:create");
    expect(result.params.topic).toBe("planner organization tips");
  });

  it("routes help to help handler", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "help",
      action: "",
      args: "",
      raw: "!help",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("help");
  });

  it("routes unknown category to unknown handler", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "unknown",
      action: "whatever",
      args: "",
      raw: "!foobar whatever",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("unknown");
  });

  it("defaults to category overview when action is missing", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "ads",
      action: "",
      args: "",
      raw: "!ads",
    };
    const result = routeCommand(cmd);
    expect(result.handler).toBe("meta:overview");
  });
});
