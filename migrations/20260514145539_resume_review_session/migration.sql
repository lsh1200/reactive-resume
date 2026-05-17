CREATE TABLE "resume_review_session" (
	"id" uuid PRIMARY KEY,
	"resume_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"doc_id" text NOT NULL UNIQUE,
	"doc_url" text NOT NULL,
	"recruiter_email" text,
	"field_map" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resume_review_session_user_id_status_index" ON "resume_review_session" ("user_id","status");--> statement-breakpoint
CREATE INDEX "resume_review_session_resume_id_status_index" ON "resume_review_session" ("resume_id","status");--> statement-breakpoint
ALTER TABLE "resume_review_session" ADD CONSTRAINT "resume_review_session_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resume_review_session" ADD CONSTRAINT "resume_review_session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;