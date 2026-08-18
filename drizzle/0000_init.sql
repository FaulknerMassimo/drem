-- pgvector must exist before any vector(768) column is created.
-- drizzle-kit does not emit extension statements, so this is prepended by hand.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TYPE "public"."attachment_kind" AS ENUM('image', 'audio');--> statement-breakpoint
CREATE TYPE "public"."auth_event_type" AS ENUM('login_success', 'login_failure', 'totp_success', 'totp_failure', 'recovery_used', 'logout', 'session_revoked', 'password_changed', 'totp_enrolled', 'totp_disabled', 'lockout', 'export_created', 'entry_deleted', 'ai_request', 'settings_changed');--> statement-breakpoint
CREATE TYPE "public"."dream_sign_category" AS ENUM('person', 'place', 'object', 'action', 'emotion', 'anomaly', 'theme');--> statement-breakpoint
CREATE TYPE "public"."dream_source" AS ENUM('typed', 'quick_capture', 'ocr', 'voice', 'import');--> statement-breakpoint
CREATE TYPE "public"."induction_technique" AS ENUM('none', 'mild', 'wbtb', 'wild', 'ssild', 'fild', 'dild', 'reality_check', 'dream_journal', 'other');--> statement-breakpoint
CREATE TYPE "public"."insight_kind" AS ENUM('extraction', 'lucidity', 'symbolic', 'report');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('embed_dream', 'extract_insight', 'lucidity_insight', 'symbolic_insight', 'period_report', 'detect_dream_signs', 'ocr_attachment', 'transcribe_attachment');--> statement-breakpoint
CREATE TYPE "public"."processing_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"dream_id" uuid,
	"kind" "attachment_kind" NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" "bytea" NOT NULL,
	"storage_key" text NOT NULL,
	"transcript_enc" "bytea",
	"status" "processing_status" DEFAULT 'pending' NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" "auth_event_type" NOT NULL,
	"succeeded" boolean DEFAULT true NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" "bytea",
	"user_agent" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "dream_sign_occurrences" (
	"dream_id" uuid NOT NULL,
	"sign_id" uuid NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	CONSTRAINT "dream_sign_occurrences_dream_id_sign_id_pk" PRIMARY KEY("dream_id","sign_id")
);
--> statement-breakpoint
CREATE TABLE "dream_signs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label_enc" "bytea" NOT NULL,
	"label_bidx" "bytea" NOT NULL,
	"category" "dream_sign_category" NOT NULL,
	"is_auto" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"lucid_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dream_tags" (
	"dream_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "dream_tags_dream_id_tag_id_pk" PRIMARY KEY("dream_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "dreams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"night_id" uuid NOT NULL,
	"dream_date" date NOT NULL,
	"title_enc" "bytea",
	"body_enc" "bytea",
	"is_lucid" boolean DEFAULT false NOT NULL,
	"lucidity" smallint DEFAULT 0 NOT NULL,
	"vividness" smallint,
	"control" smallint,
	"recall_clarity" smallint,
	"emotional_valence" smallint,
	"is_nightmare" boolean DEFAULT false NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"is_fragment" boolean DEFAULT false NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"source" "dream_source" DEFAULT 'typed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"dream_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"vector_enc" "bytea",
	"vector" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"dream_id" uuid,
	"kind" "insight_kind" NOT NULL,
	"period_start" date,
	"period_end" date,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"content_enc" "bytea" NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "processing_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"bed_time" time,
	"wake_time" time,
	"wbtb_time" time,
	"sleep_quality" smallint,
	"techniques" "induction_technique"[] DEFAULT '{}' NOT NULL,
	"no_recall" boolean DEFAULT false NOT NULL,
	"notes_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint" "bytea" NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_hash" "bytea",
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"ai_config_enc" "bytea",
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name_enc" "bytea" NOT NULL,
	"name_bidx" "bytea" NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"kek_salt" "bytea" NOT NULL,
	"kdf_params" jsonb NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"dek_wrapped_master" "bytea",
	"totp_secret_enc" "bytea",
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_last_step" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_sign_occurrences" ADD CONSTRAINT "dream_sign_occurrences_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_sign_occurrences" ADD CONSTRAINT "dream_sign_occurrences_sign_id_dream_signs_id_fk" FOREIGN KEY ("sign_id") REFERENCES "public"."dream_signs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_signs" ADD CONSTRAINT "dream_signs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_tags" ADD CONSTRAINT "dream_tags_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dream_tags" ADD CONSTRAINT "dream_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreams" ADD CONSTRAINT "dreams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreams" ADD CONSTRAINT "dreams_night_id_nights_id_fk" FOREIGN KEY ("night_id") REFERENCES "public"."nights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_dream_id_dreams_id_fk" FOREIGN KEY ("dream_id") REFERENCES "public"."dreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nights" ADD CONSTRAINT "nights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_user_idx" ON "attachments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attachments_dream_idx" ON "attachments" USING btree ("dream_id");--> statement-breakpoint
CREATE INDEX "attachments_status_idx" ON "attachments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "auth_events_user_at_idx" ON "auth_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "auth_events_type_idx" ON "auth_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "dream_sign_occurrences_sign_idx" ON "dream_sign_occurrences" USING btree ("sign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dream_signs_user_bidx_idx" ON "dream_signs" USING btree ("user_id","label_bidx");--> statement-breakpoint
CREATE INDEX "dream_tags_tag_idx" ON "dream_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "dreams_user_date_idx" ON "dreams" USING btree ("user_id","dream_date");--> statement-breakpoint
CREATE INDEX "dreams_night_idx" ON "dreams" USING btree ("night_id");--> statement-breakpoint
CREATE INDEX "dreams_lucid_idx" ON "dreams" USING btree ("user_id","is_lucid");--> statement-breakpoint
CREATE INDEX "dreams_draft_idx" ON "dreams" USING btree ("user_id","is_draft");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_dream_model_idx" ON "embeddings" USING btree ("dream_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_user_idx" ON "embeddings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "insights_dream_kind_idx" ON "insights" USING btree ("dream_id","kind");--> statement-breakpoint
CREATE INDEX "insights_user_kind_idx" ON "insights" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "jobs_pending_idx" ON "jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nights_user_date_idx" ON "nights" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_bidx_idx" ON "tags" USING btree ("user_id","name_bidx");