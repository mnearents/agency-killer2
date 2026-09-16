ALTER TABLE "voice_banned_words" ADD COLUMN "severity" text DEFAULT 'avoid' NOT NULL;
-- Every existing word is a style preference, so the default is correct for all
-- seven: synergy, delight, shenanigans, alrighty, "let's do this",
-- "these babies", brighter. None is unpublishable.
--
-- Before this, any of them refused a draft outright. #60: "Delight shouldn't
-- be a hard ban, I just would rather not use that word. But it shouldn't cause
-- an entire response to fail."
COMMENT ON COLUMN "voice_banned_words"."severity" IS
  'block = refuse copy containing this word; avoid = flag it only. Defaults to avoid.';
