ALTER TABLE "jobs" ADD COLUMN "progress_phase" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "progress_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;