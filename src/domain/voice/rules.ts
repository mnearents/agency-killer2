/**
 * Channel/intent vocabulary and the three-layer rule structure.
 *
 * ## The layers
 *
 * 1. **Global rules** — apply on every channel. `exceptIn: []`.
 * 2. **Channel-scoped rules** — apply everywhere *except* the channels listed.
 * 3. **Banned words** — a flat vocabulary list, global, enforced separately
 *    because it is authored and synced as its own thing.
 *
 * ## Why scope is "except in" rather than "applies to"
 *
 * Every rule here is a prohibition. Expressed as an allow-list of channels, a
 * channel nobody remembered to add inherits *no* prohibitions and reports
 * compliant — the failure is silent and looks like a pass. Expressed as an
 * exclusion list, a new channel inherits *every* prohibition, which is wrong in
 * the safe direction: someone notices a rule firing where it should not, and
 * nobody ships copy that was never checked.
 *
 * ## Why the registry is keyed by rule text
 *
 * Rules are authored in `voice-profile-seed.json` and in the `/voice` dashboard,
 * and stored in `voice_rules` with the text as the source key. Putting scope and
 * enforcement in the database would mean a migration and a second authoring
 * surface for something only code can act on. Keying on the text instead means
 * the seed file stays the authoring surface.
 *
 * The cost is that editing a rule's wording orphans its registry entry and
 * silently downgrades it to unenforced. `rules.test.ts` asserts every seed rule
 * has an entry, so that drift goes red instead of quiet.
 *
 * ## Unenforced rules are allowed, but never invisible
 *
 * Most voice guidance cannot be pattern-matched — "sound like a friend" has no
 * regex. Those rules still belong in the prompt. What is not allowed is for them
 * to *look* enforced: `rulesForChannel` marks them `unenforced`, and `voiceCheck`
 * reports them alongside its verdict, so a clean result over three uncheckable
 * rules cannot be mistaken for a clean result over three checked ones.
 */

export const CHANNELS = ["instagram", "email", "sms", "ad", "product_page"] as const;
export type Channel = (typeof CHANNELS)[number];

export const INTENTS = ["launch", "nurture", "story", "educational", "promo"] as const;
export type Intent = (typeof INTENTS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

/**
 * The audience for copy whose channel is not known.
 *
 * Every rule here is a prohibition and every scope is an exclusion, so the
 * strictest possible audience is the one excused from nothing. `unspecified`
 * resolves to exactly that: all global rules, plus every channel-scoped rule
 * that some channel would be excused from.
 *
 * The alternative is a default channel, and `/api/generate` shipped one — it
 * defaulted to `instagram` on the reasoning that the Figma plugin is an
 * Instagram tool. Matt uses that plugin mostly for **email**, so the default
 * applied Instagram's *exclusions* to email copy and would have permitted "link
 * in bio" and comment-to-DM CTAs in an inbox. That is the leakage the scoping
 * exists to stop, shipped as a default and invisible because the output still
 * looked checked.
 *
 * `unspecified` is not a channel. It cannot tag a sample, `isChannel` rejects
 * it, and it never appears in `exceptIn` — same reasoning as `exceptIn` over
 * `appliesTo`: an unknown audience is wrong in the direction someone notices.
 */
export const UNSPECIFIED = "unspecified" as const;

/** A real channel, or the deliberate absence of one. */
export type RuleAudience = Channel | typeof UNSPECIFIED;

export function isRuleAudience(value: unknown): value is RuleAudience {
  return value === UNSPECIFIED || isChannel(value);
}

/**
 * How a rule is checked.
 *
 * `unenforced` is a first-class state, not an error. The alternative — dropping
 * uncheckable rules, or pretending a prompt instruction is a guardrail — is how
 * a rules list becomes decorative.
 */
export type RuleEnforcement =
  | { kind: "forbids"; pattern: RegExp }
  | { kind: "unenforced"; why: string };

export interface RuleScope {
  /** Channels this rule does NOT apply to. Empty means every channel. */
  exceptIn: Channel[];
  enforcement: RuleEnforcement;
}

export interface ScopedRule {
  text: string;
  enforcement: RuleEnforcement;
}

/**
 * Tara writes "dang", "freaking", "heck", "crap" and "booty" constantly and
 * "damn" never — so this list is tuned to her register, not to a generic profanity
 * filter. A guardrail that trips on "so dang happy" blocks correct copy, and a
 * guardrail that blocks correct copy gets turned off.
 */
const VULGARITY = /\b(?:fuck|shit|bitch|bastard|asshole|cunt|goddamn|damn|piss)\w*/i;

/**
 * Em dash and en dash, plus the double hyphen people type when they mean one.
 */
const EM_DASH = /[—–]|(?<=\s)--(?=\s)/;

/**
 * A comment-to-DM CTA is correct Instagram copy — five of Tara's captions use it
 * (IG2, IG6, IG8, IG19, IG32) — and meaningless in an inbox or a text message.
 */
const COMMENTS_GET = /comments?\s+get\b/i;

const LINK_IN_BIO = /\blink in (?:my |your |the )?(?:bio|profile|stories)\b/i;

export const RULE_REGISTRY: Record<string, RuleScope> = {
  "Never use em dashes": {
    exceptIn: [],
    enforcement: { kind: "forbids", pattern: EM_DASH },
  },
  "No vulgarity": {
    exceptIn: [],
    enforcement: { kind: "forbids", pattern: VULGARITY },
  },
  "Don't say \"comments get\" as if you're writing an instagram post.": {
    exceptIn: ["instagram"],
    enforcement: { kind: "forbids", pattern: COMMENTS_GET },
  },
  'Don\'t say "link in bio" outside instagram.': {
    exceptIn: ["instagram"],
    enforcement: { kind: "forbids", pattern: LINK_IN_BIO },
  },
};

/**
 * The rules that apply for `audience`, each carrying how (or whether) it is
 * enforced.
 *
 * A rule with no registry entry — one typed into the `/voice` dashboard, or one
 * whose wording drifted — is kept and applied on every channel, and marked
 * unenforced. Dropping it would silently discard brand guidance; scoping it
 * narrowly would be a guess.
 *
 * `UNSPECIFIED` is excused from nothing, so it is never more permissive than any
 * real channel.
 */
export function rulesForChannel(rules: string[], audience: RuleAudience): ScopedRule[] {
  const applicable: ScopedRule[] = [];

  for (const text of rules) {
    const scope = RULE_REGISTRY[text];

    if (!scope) {
      applicable.push({
        text,
        enforcement: {
          kind: "unenforced",
          why: "no registry entry — authored outside the seed file, or the wording changed",
        },
      });
      continue;
    }

    // `UNSPECIFIED` is never in `exceptIn` — it is not a channel — but the
    // check is explicit rather than incidental, so widening the type later
    // cannot quietly make the strictest audience a permissive one.
    if (audience !== UNSPECIFIED && scope.exceptIn.includes(audience)) continue;

    applicable.push({ text, enforcement: scope.enforcement });
  }

  return applicable;
}

/**
 * Samples carry their channel as a namespaced tag — `channel:instagram` — in the
 * `tags` array, because that is the shape the corpus was authored in (#58) and
 * a `channel` column would need a migration plus a second authoring surface.
 *
 * The prefix and the parser live here, next to `CHANNELS`, for the same reason
 * `corpus.test.ts` imports that vocabulary rather than redeclaring it: a second
 * copy of the tag format drifts from the one selection actually filters on, and
 * the failure is a smaller result set, not an error.
 */
export const CHANNEL_TAG_PREFIX = "channel:";

export function channelTag(channel: Channel): string {
  return `${CHANNEL_TAG_PREFIX}${channel}`;
}

/**
 * The channel a sample is tagged for, or `null` when it carries no recognised
 * one — untagged, typo'd, or tagged for a channel this code does not know.
 *
 * `null` means "belongs to no channel", which is why an untagged sample is
 * reachable through the whole-corpus paths but is never selected *for* a
 * channel. A sample silently promoted into a channel it was not tagged for
 * would teach that channel's voice from the wrong examples.
 */
export function channelOfSample(tags: readonly string[] | undefined | null): Channel | null {
  for (const tag of tags ?? []) {
    if (!tag.startsWith(CHANNEL_TAG_PREFIX)) continue;
    const value = tag.slice(CHANNEL_TAG_PREFIX.length);
    if (isChannel(value)) return value;
  }
  return null;
}
