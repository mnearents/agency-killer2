ALTER TABLE "social_posts" ADD COLUMN "transcription_status" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "transcription_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "transcription_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "social_posts_transcription_idx" ON "social_posts" USING btree ("transcription_status");--> statement-breakpoint
-- Backfill transcription state from what the knowledge base already holds.
--
-- Before this column, a video with no transcript was stored as a kb_documents
-- row reading "(No audio transcript available)" so the next run would skip it.
-- That made a transient AssemblyAI failure permanent and indistinguishable
-- from a genuinely silent video.
--
-- Posts whose transcript exists are `ok`. The 85 without one become `unknown`
-- rather than `no-audio`: the cause was discarded at the time, and calling
-- them no-audio would assert something nobody measured. `unknown` is
-- retryable, so the next runs establish the real answer.
UPDATE social_posts sp SET
  transcription_status = 'ok',
  transcription_attempts = 1,
  transcription_attempted_at = kb.created_at
FROM kb_documents kb
WHERE kb.source_file = 'ig:' || sp.id
  AND kb.category = 'social-transcript'
  AND kb.content NOT LIKE '%(No audio transcript available)%';
--> statement-breakpoint
UPDATE social_posts sp SET
  transcription_status = 'unknown',
  transcription_attempts = 1,
  transcription_attempted_at = kb.created_at
FROM kb_documents kb
WHERE kb.source_file = 'ig:' || sp.id
  AND kb.category = 'social-transcript'
  AND kb.content LIKE '%(No audio transcript available)%';
--> statement-breakpoint
-- The placeholders are not knowledge. They were only ever a dedupe marker, and
-- that job now belongs to social_posts.transcription_status. Left here they
-- are listed by kb_documents, counted against embedding coverage, and can
-- never be returned by a search.
DELETE FROM kb_documents
WHERE category = 'social-transcript'
  AND content LIKE '%(No audio transcript available)%';
