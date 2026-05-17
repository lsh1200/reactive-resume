import * as pg from "drizzle-orm/pg-core";
import { defaultResumeData, type ResumeData } from "../../schema/resume/data";
import { generateId } from "../../utils/string";

export const user = pg.pgTable(
	"user",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		image: pg.text("image"),
		name: pg.text("name").notNull(),
		email: pg.text("email").notNull().unique(),
		emailVerified: pg.boolean("email_verified").notNull().default(false),
		username: pg.text("username").notNull().unique(),
		displayUsername: pg.text("display_username").notNull().unique(),
		twoFactorEnabled: pg.boolean("two_factor_enabled").notNull().default(false),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.createdAt.asc())],
);

export const session = pg.pgTable(
	"session",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		token: pg.text("token").notNull().unique(),
		ipAddress: pg.text("ip_address"),
		userAgent: pg.text("user_agent"),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.token, t.userId), pg.index().on(t.expiresAt)],
);

export const account = pg.pgTable(
	"account",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		accountId: pg.text("account_id").notNull(),
		providerId: pg.text("provider_id").notNull().default("credential"),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		scope: pg.text("scope"),
		idToken: pg.text("id_token"),
		password: pg.text("password"),
		accessToken: pg.text("access_token"),
		refreshToken: pg.text("refresh_token"),
		accessTokenExpiresAt: pg.timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: pg.timestamp("refresh_token_expires_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId)],
);

export const verification = pg.pgTable("verification", {
	id: pg
		.uuid("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => generateId()),
	identifier: pg.text("identifier").notNull().unique(),
	value: pg.text("value").notNull(),
	expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: pg
		.timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date()),
});

export const twoFactor = pg.pgTable(
	"two_factor",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		secret: pg.text("secret"),
		backupCodes: pg.text("backup_codes"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId), pg.index().on(t.secret)],
);

export const passkey = pg.pgTable(
	"passkey",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: pg.text("name"),
		aaguid: pg.text("aaguid"),
		publicKey: pg.text("public_key").notNull(),
		credentialID: pg.text("credential_id").notNull(),
		counter: pg.integer("counter").notNull(),
		deviceType: pg.text("device_type").notNull(),
		backedUp: pg.boolean("backed_up").notNull().default(false),
		transports: pg.text("transports").notNull(),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId)],
);

export const resume = pg.pgTable(
	"resume",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: pg.text("name").notNull(),
		slug: pg.text("slug").notNull(),
		tags: pg.text("tags").array().notNull().default([]),
		isPublic: pg.boolean("is_public").notNull().default(false),
		isLocked: pg.boolean("is_locked").notNull().default(false),
		password: pg.text("password"),
		data: pg
			.jsonb("data")
			.notNull()
			.$type<ResumeData>()
			.$defaultFn(() => defaultResumeData),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.unique().on(t.slug, t.userId),
		pg.index().on(t.userId),
		pg.index().on(t.createdAt.asc()),
		pg.index().on(t.userId, t.updatedAt.desc()),
		pg.index().on(t.isPublic, t.slug, t.userId),
	],
);

export const resumeStatistics = pg.pgTable("resume_statistics", {
	id: pg
		.uuid("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => generateId()),
	views: pg.integer("views").notNull().default(0),
	downloads: pg.integer("downloads").notNull().default(0),
	lastViewedAt: pg.timestamp("last_viewed_at", { withTimezone: true }),
	lastDownloadedAt: pg.timestamp("last_downloaded_at", { withTimezone: true }),
	resumeId: pg
		.uuid("resume_id")
		.unique()
		.notNull()
		.references(() => resume.id, { onDelete: "cascade" }),
	createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: pg
		.timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date()),
});

export const resumeReviewSession = pg.pgTable(
	"resume_review_session",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		resumeId: pg
			.uuid("resume_id")
			.notNull()
			.references(() => resume.id, { onDelete: "cascade" }),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		docId: pg.text("doc_id").notNull(),
		docUrl: pg.text("doc_url").notNull(),
		pdfDriveFileId: pg.text("pdf_drive_file_id"),
		pdfDriveUrl: pg.text("pdf_drive_url"),
		recruiterEmail: pg.text("recruiter_email"),
		fieldMap: pg.jsonb("field_map").notNull(),
		status: pg.text("status").notNull().default("open"),
		lastSyncedAt: pg.timestamp("last_synced_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.userId, t.status),
		pg.index().on(t.resumeId, t.status),
		pg.unique().on(t.docId),
	],
);

export const resumeCodexProposal = pg.pgTable(
	"resume_codex_proposal",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		resumeId: pg
			.uuid("resume_id")
			.notNull()
			.references(() => resume.id, { onDelete: "cascade" }),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		batchId: pg.uuid("batch_id").notNull(),
		title: pg.text("title").notNull(),
		jsonPath: pg.text("json_path").notNull(),
		beforeValue: pg.jsonb("before_value"),
		afterValue: pg.jsonb("after_value"),
		reasoning: pg.text("reasoning"),
		commentIds: pg.text("comment_ids").array().notNull().default([]),
		driveCommentIds: pg.text("drive_comment_ids").array().notNull().default([]),
		docId: pg.text("doc_id"),
		status: pg.text("status").notNull().default("pending"),
		decidedAt: pg.timestamp("decided_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.resumeId, t.status),
		pg.index().on(t.batchId),
		pg.index().on(t.userId),
	],
);

export const resumeCodexUndo = pg.pgTable(
	"resume_codex_undo",
	{
		resumeId: pg
			.uuid("resume_id")
			.notNull()
			.primaryKey()
			.references(() => resume.id, { onDelete: "cascade" }),
		userId: pg
			.uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		previousData: pg.jsonb("previous_data").$type<ResumeData>().notNull(),
		appliedCommentIds: pg.text("applied_comment_ids").array().notNull().default([]),
		driveCommentIds: pg.text("drive_comment_ids").array().notNull().default([]),
		docId: pg.text("doc_id"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId)],
);

export const resumeReviewComment = pg.pgTable(
	"resume_review_comment",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		sessionId: pg
			.uuid("session_id")
			.notNull()
			.references(() => resumeReviewSession.id, { onDelete: "cascade" }),
		driveCommentId: pg.text("drive_comment_id").notNull(),
		jsonPath: pg.text("json_path"),
		anchoredText: pg.text("anchored_text"),
		commentText: pg.text("comment_text").notNull(),
		authorName: pg.text("author_name"),
		authorEmail: pg.text("author_email"),
		status: pg.text("status").notNull().default("open"),
		driveCreatedAt: pg.timestamp("drive_created_at", { withTimezone: true }),
		syncedAt: pg.timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
		appliedAt: pg.timestamp("applied_at", { withTimezone: true }),
		appliedNote: pg.text("applied_note"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.unique().on(t.sessionId, t.driveCommentId),
		pg.index().on(t.sessionId, t.status),
	],
);

export const googleDocsConnection = pg.pgTable(
	"google_docs_connection",
	{
		userId: pg
			.uuid("user_id")
			.notNull()
			.primaryKey()
			.references(() => user.id, { onDelete: "cascade" }),
		googleSub: pg.text("google_sub").notNull(),
		googleEmail: pg.text("google_email").notNull(),
		accessToken: pg.text("access_token").notNull(),
		refreshToken: pg.text("refresh_token"),
		scope: pg.text("scope").notNull(),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.googleSub)],
);

export const apikey = pg.pgTable(
	"apikey",
	{
		id: pg
			.uuid("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: pg.text("name"),
		start: pg.text("start"),
		prefix: pg.text("prefix"),
		key: pg.text("key").notNull(),
		configId: pg.text("config_id").notNull().default("default"),
		referenceId: pg
			.uuid("reference_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		refillInterval: pg.integer("refill_interval"),
		refillAmount: pg.integer("refill_amount"),
		lastRefillAt: pg.timestamp("last_refill_at", { withTimezone: true }),
		enabled: pg.boolean("enabled").notNull().default(true),
		rateLimitEnabled: pg.boolean("rate_limit_enabled").notNull().default(false),
		rateLimitTimeWindow: pg.integer("rate_limit_time_window"),
		rateLimitMax: pg.integer("rate_limit_max"),
		requestCount: pg.integer("request_count").notNull().default(0),
		remaining: pg.integer("remaining"),
		lastRequest: pg.timestamp("last_request", { withTimezone: true }),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
		permissions: pg.text("permissions"),
		metadata: pg.jsonb("metadata"),
	},
	(t) => [pg.index().on(t.referenceId), pg.index().on(t.key), pg.index().on(t.enabled, t.referenceId)],
);
