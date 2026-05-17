CREATE TABLE "resume_review_comment" (
	"id" uuid PRIMARY KEY,
	"session_id" uuid NOT NULL,
	"drive_comment_id" text NOT NULL,
	"json_path" text,
	"anchored_text" text,
	"comment_text" text NOT NULL,
	"author_name" text,
	"author_email" text,
	"status" text DEFAULT 'open' NOT NULL,
	"drive_created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_review_comment_session_id_drive_comment_id_unique" UNIQUE("session_id","drive_comment_id")
);
--> statement-breakpoint
CREATE INDEX "resume_review_comment_session_id_status_index" ON "resume_review_comment" ("session_id","status");--> statement-breakpoint
ALTER TABLE "resume_review_comment" ADD CONSTRAINT "resume_review_comment_session_id_resume_review_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "resume_review_session"("id") ON DELETE CASCADE;