-- Voice corpus rows learn which seed entry they came from.
--
-- The seed file is where the corpus is authored; voice_samples is what every
-- generation reads. The only bridge was seedVoiceProfileToDb, which runs when
-- all three voice tables are empty and never again. Production filled them on
-- first boot, so from that point every edit to voice-profile-seed.json was a
-- no-op with a real diff, a green suite and a clean deploy behind it.
--
-- source_key closes that: non-NULL means the seed file owns the row and may
-- rewrite or remove it; NULL means a person wrote it through /voice, the API,
-- or `!voice add`, and the file has no authority over it.
--
-- The backfill below matches on md5(content) rather than on title, because
-- title is not unique — IG13 appears twice with different content, and IG9 is
-- absent. Content is exact and distinct across all 34 rows.

ALTER TABLE "voice_samples" ADD COLUMN IF NOT EXISTS "source_key" text;
ALTER TABLE "voice_rules" ADD COLUMN IF NOT EXISTS "source_key" text;
ALTER TABLE "voice_banned_words" ADD COLUMN IF NOT EXISTS "source_key" text;

-- Backfill: 34 seed samples, matched by content hash.
UPDATE "voice_samples" SET "source_key" = '1760734083567' WHERE md5("content") = '8d3fee5c0d6779db290fc368d03da6f8' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734102642' WHERE md5("content") = 'fa2eb5092627d957ba623ed0fe978fb0' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734115575' WHERE md5("content") = '99bc064d8d580c60b3f7d3ba2ea62f1c' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734130088' WHERE md5("content") = 'faffcf968b8b14d6b94780f3f8548dca' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734147451' WHERE md5("content") = 'f1353833fd3cf50b615c4892809f53ad' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734171129' WHERE md5("content") = '001798056edd95f4ba311c3f347fdbb4' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734188135' WHERE md5("content") = '482a24dc85a2a4971cb573d742633d95' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734200894' WHERE md5("content") = 'c2eb628aa6ba833a87e656f796d6828e' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734211047' WHERE md5("content") = 'f0901ba9694ae7dd47a19e651e1948e4' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734225020' WHERE md5("content") = 'bd581018bb2d0910e9649b0ebb6ecb80' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734234994' WHERE md5("content") = '0b3dff070197bc13009756a20e293dfc' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734252521' WHERE md5("content") = '8c2a81f46a5eb09ea92822df4ea736b0' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734264182' WHERE md5("content") = '6fb8d8aecd00815c1dda7dd569013656' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734282091' WHERE md5("content") = '4da4c257174d123d4ffd37e3b4ec5541' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734303300' WHERE md5("content") = '224e4c5fab39fdd304ea5168a00a4b35' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734316775' WHERE md5("content") = 'aaf422a5144d5e27b3c71d9435b0e414' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734332488' WHERE md5("content") = 'c0e59650d7802e4d6c76a5d5d71e380c' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734343226' WHERE md5("content") = '7d5f666838822fcda5afa996b98c9750' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734359422' WHERE md5("content") = '033efd69cfb1c1774201c7d9c9396a0b' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734374812' WHERE md5("content") = '2fef6b9c598c1ea91bc0b7fad32533e9' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734385737' WHERE md5("content") = '107ad974f0e06584f8df40644b4f37e5' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734400661' WHERE md5("content") = '8e538b0cb4debafbba559c70ae3426d2' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734415309' WHERE md5("content") = '35e3496e45c1c733ba55c3c30a1ba7ac' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734426923' WHERE md5("content") = '765b9545700f41affa183f9259723cc6' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734436530' WHERE md5("content") = '9a579d5ff116e26e802b56d473a07532' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734455385' WHERE md5("content") = 'a3f68901c30bffef45389751b85c13bc' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734470103' WHERE md5("content") = 'e16e25eca63c6645cdf295117df7e98c' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734482024' WHERE md5("content") = '82138e2c10f353e91454eab957226d8a' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734494969' WHERE md5("content") = 'c7be620d87d51a211c94676b2f0256e7' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734512998' WHERE md5("content") = '28fbb81097d6665bf6e21e5a67218b7c' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734529254' WHERE md5("content") = 'f468cb5f8c0c825880cced39ec61ca6b' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734612110' WHERE md5("content") = 'dead11a861d7557569a53d7e1e87d976' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734622174' WHERE md5("content") = 'aca503db3b87b542266dcd364ea1ee68' AND "source_key" IS NULL;
UPDATE "voice_samples" SET "source_key" = '1760734656077' WHERE md5("content") = 'cf59977baa98adcf4390c12aba1b1e98' AND "source_key" IS NULL;

-- Rules and banned words have no identity beyond their text.
UPDATE "voice_rules" SET "source_key" = 'Never use em dashes' WHERE "rule" = 'Never use em dashes' AND "source_key" IS NULL;
UPDATE "voice_rules" SET "source_key" = 'No vulgarity' WHERE "rule" = 'No vulgarity' AND "source_key" IS NULL;
UPDATE "voice_rules" SET "source_key" = 'Don''t say "comments get" as if you''re writing an instagram post.' WHERE "rule" = 'Don''t say "comments get" as if you''re writing an instagram post.' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'synergy' WHERE "word" = 'synergy' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'delight' WHERE "word" = 'delight' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'shenanigans' WHERE "word" = 'shenanigans' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'alrighty' WHERE "word" = 'alrighty' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'let''s do this' WHERE "word" = 'let''s do this' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'these babies' WHERE "word" = 'these babies' AND "source_key" IS NULL;
UPDATE "voice_banned_words" SET "source_key" = 'brighter' WHERE "word" = 'brighter' AND "source_key" IS NULL;

-- Unique after the backfill, not before: a duplicate source_key would mean two
-- rows claiming the same seed entry, which the sync cannot resolve.
CREATE UNIQUE INDEX IF NOT EXISTS "voice_samples_source_key_unique" ON "voice_samples" ("source_key");
CREATE UNIQUE INDEX IF NOT EXISTS "voice_rules_source_key_unique" ON "voice_rules" ("source_key");
CREATE UNIQUE INDEX IF NOT EXISTS "voice_banned_words_source_key_unique" ON "voice_banned_words" ("source_key");

COMMENT ON COLUMN "voice_samples"."source_key" IS
  'Seed-file entry id. NULL means a person authored this row and the seed file must not touch it.';
