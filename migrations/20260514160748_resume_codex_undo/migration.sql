CREATE TABLE "resume_codex_undo" (
	"resume_id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"previous_data" jsonb NOT NULL,
	"applied_comment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"drive_comment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"doc_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resume_codex_undo_user_id_index" ON "resume_codex_undo" ("user_id");--> statement-breakpoint
ALTER TABLE "resume_codex_undo" ADD CONSTRAINT "resume_codex_undo_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resume_codex_undo" ADD CONSTRAINT "resume_codex_undo_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;