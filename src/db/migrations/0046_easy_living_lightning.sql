-- Word timings for footage (#13). Transcripts made before this kept only their
-- text; the footage sync recovers their words from AssemblyAI, which still
-- holds every transcript, and transcribes again only what it cannot match.
ALTER TABLE "footage" ADD COLUMN "transcript_id" text;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "words" jsonb;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "duration_ms" integer;