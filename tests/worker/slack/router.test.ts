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

  // `!sync` alone runs everything; a mistyped target must not.
  it("refuses a sync target it does not know rather than running every sync", () => {
    expect(routeCommand({ type: "command", category: "sync", action: "teachers", args: "1", raw: "!sync teachers 1" }).handler).toBe("unknown");
    expect(routeCommand({ type: "command", category: "sync", action: "", args: "", raw: "!sync" }).handler).toBe("sync:all");
    expect(routeCommand({ type: "command", category: "sync", action: "all", args: "", raw: "!sync all" }).handler).toBe("sync:all");
  });

  it("takes reel as well as reels", () => {
    expect(routeCommand({ type: "command", category: "sync", action: "reel", args: "peers 1", raw: "!sync reel peers 1" }).handler).toBe("sync:reels");
  });

  // Footage has to be named.
  it("routes ads watch to the ad account watch", () => {
    expect(routeCommand({
      type: "command", category: "ads", action: "watch", args: "", raw: "!ads watch",
    }).handler).toBe("watch:meta");
  });

  it("routes sync footage to the footage sync alone", () => {
    const cmd: ParsedCommand = {
      type: "command",
      category: "sync",
      action: "footage",
      args: "",
      raw: "!sync footage",
    };
    expect(routeCommand(cmd).handler).toBe("sync:footage");
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

describe("teacher video links", () => {
  // A pasted link is a video to learn from; a question that mentions one is still a question.
  it("routes a message that starts with an Instagram link to teacher:learn, keeping the whole message", () => {
    const text = "<https://www.instagram.com/reel/DAbc123/?igsh=x|instagram.com/reel/DAbc123> @lana.k.social great hook";
    const parsed = parseMessage(text);
    expect(parsed).toEqual({ type: "command", category: "learn", action: "", args: text, raw: text });
    expect(routeCommand(parsed as ParsedCommand).handler).toBe("teacher:learn");
  });

  it("routes bare links, post links and links with the creator in the path", () => {
    for (const text of ["https://www.instagram.com/reel/DAbc123/", "https://instagram.com/p/Cxyz789/", "https://www.instagram.com/lana.k.social/reel/Qrst456/"]) {
      expect(parseMessage(text)).toMatchObject({ type: "command", category: "learn" });
    }
  });

  it("leaves a question that mentions a link, and a profile link, as natural language", () => {
    expect(parseMessage("what do you think of https://www.instagram.com/reel/DAbc123/ ?").type).toBe("natural");
    expect(parseMessage("https://www.instagram.com/lana.k.social/").type).toBe("natural");
  });

  // Shortcodes are case-sensitive: `!learn` must not lowercase the link.
  it("keeps !learn's link exactly as typed", () => {
    const parsed = parseMessage("!learn https://www.instagram.com/reel/DAbC123xYz/ @Lana why");
    expect(parsed).toMatchObject({ type: "command", category: "learn", action: "", args: "https://www.instagram.com/reel/DAbC123xYz/ @Lana why" });
    expect(routeCommand(parsed as ParsedCommand).handler).toBe("teacher:learn");
  });
});
