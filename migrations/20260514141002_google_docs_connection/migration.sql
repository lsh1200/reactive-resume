CREATE TABLE "google_docs_connection" (
	"user_id" uuid PRIMARY KEY,
	"google_sub" text NOT NULL,
	"google_email" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "config_id" SET DEFAULT 'default';--> statement-breakpoint
CREATE INDEX "google_docs_connection_google_sub_index" ON "google_docs_connection" ("google_sub");--> statement-breakpoint
ALTER TABLE "google_docs_connection" ADD CONSTRAINT "google_docs_connection_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;