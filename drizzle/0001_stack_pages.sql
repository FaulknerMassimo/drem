ALTER TABLE "attachments" ADD COLUMN "stack_id" uuid;--> statement-breakpoint
CREATE INDEX "attachments_stack_idx" ON "attachments" USING btree ("stack_id");