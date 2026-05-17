CREATE TABLE "resume_codex_proposal" (
	"id" uuid PRIMARY KEY,
	"resume_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"title" text NOT NULL,
	"json_path" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"reasoning" text,
	"comment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"drive_comment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"doc_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resume_codex_proposal_resume_id_status_index" ON "resume_codex_proposal" ("resume_id","status");--> statement-breakpoint
CREATE INDEX "resume_codex_proposal_batch_id_index" ON "resume_codex_proposal" ("batch_id");--> statement-breakpoint
CREATE INDEX "resume_codex_proposal_user_id_index" ON "resume_codex_proposal" ("user_id");--> statement-breakpoint
ALTER TABLE "resume_codex_proposal" ADD CONSTRAINT "resume_codex_proposal_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resume_codex_proposal" ADD CONSTRAINT "resume_codex_proposal_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;