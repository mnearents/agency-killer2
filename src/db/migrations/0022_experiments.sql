-- Experiments: the accountability layer.
--
-- Two tables, both insert-only. The declaration is written before the answer is
-- known; results are written after. Keeping them apart is what makes the
-- pre-declaration real: there is no code path that can edit success_criteria
-- once a result exists, because recording a result writes a different table.
--
-- success_criteria and baseline_basis are NOT NULL by design. A nullable
-- success_criteria is an invitation to skip the only step that makes the record
-- worth keeping, and it would be skipped on exactly the experiments whose
-- outcome is least certain.
--
-- There is deliberately no `outcome` column on `experiments`. Status is derived
-- in src/domain/experiments/experiments.ts from the declared window and the
-- results, so a stored 'running' cannot sit there going stale.
--
-- HAND-WRITTEN. `drizzle-kit generate` produced this file plus the whole of
-- 0016-0021 again -- CREATE TABLE segments, CREATE TABLE shopify_customers,
-- ADD COLUMN inventory_item_id, and three ADD CONSTRAINTs -- because snapshots
-- were never written for those hand-written migrations, so the diff ran against
-- 0019. Every one of those objects already exists in production (verified), and
-- applying that generated file would have failed on the first CREATE TABLE.
-- Only the experiments DDL below is new. 0022_snapshot.json is kept as
-- generated: it is an accurate picture of schema.ts, which is what makes the
-- NEXT generate diff correctly.

CREATE TABLE IF NOT EXISTS "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"what_we_changed" text NOT NULL,
	"success_criteria" text NOT NULL,
	"primary_metric" text NOT NULL,
	"baseline_value" real,
	"baseline_basis" text NOT NULL,
	"start_date" date NOT NULL,
	"planned_end_date" date NOT NULL,
	"related_note_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiment_results" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"outcome" text NOT NULL,
	"result_value" real,
	"concluded_on" date NOT NULL,
	"learnings" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_created_idx" ON "experiments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_planned_end_idx" ON "experiments" USING btree ("planned_end_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_results_experiment_idx" ON "experiment_results" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_results_created_idx" ON "experiment_results" USING btree ("created_at");

COMMENT ON COLUMN "experiments"."success_criteria" IS
  'Declared before the result is known. There is no UPDATE path to this column anywhere in the codebase, and that is the point.';
