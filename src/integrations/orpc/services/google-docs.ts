import { ORPCError } from "@orpc/client";
import { and, desc, eq, inArray } from "drizzle-orm";
import { get, set } from "es-toolkit/compat";
import { randomUUID } from "node:crypto";
import { schema } from "@/integrations/drizzle";
import { db } from "@/integrations/drizzle/client";
import { findBestFieldMatch, parseDriveAnchor } from "@/integrations/google-docs/anchor";
import {
	CodexRunError,
	type CommentForCodex,
	runCodexProposals,
} from "@/integrations/google-docs/codex-runner";
import {
	batchUpdate,
	buildDocumentUrl,
	buildDriveFileUrl,
	createDocument,
	createDriveFile,
	deleteDriveFile,
	type DriveComment,
	getBodyEndIndex,
	getDocument,
	GoogleApiError,
	listComments,
	shareFileWithEmail,
	updateDriveFileMedia,
} from "@/integrations/google-docs/api";
import { printerService } from "./printer";
import {
	disconnect as disconnectConnection,
	getAccessToken,
	getConnection,
	GOOGLE_DOCS_SCOPES,
	GoogleDocsNotConnectedError,
	isGoogleDocsConfigured,
} from "@/integrations/google-docs/oauth";
import { type FieldMapEntry, renderResumeToDoc } from "@/integrations/google-docs/renderer";
import type { ResumeData } from "@/schema/resume/data";
import { logger } from "@/utils/logger";

export type GoogleDocsStatus = {
	configured: boolean;
	connected: boolean;
	googleEmail: string | null;
	scopes: string[];
	connectedAt: string | null;
	expiresAt: string | null;
	missingScopes: string[];
};

export type PublishForReviewResult = {
	sessionId: string;
	docId: string;
	docUrl: string;
	fieldMapSize: number;
	shared: boolean;
	shareError: string | null;
	reused: boolean;
};

export type ReviewSessionSummary = {
	id: string;
	resumeId: string;
	docId: string;
	docUrl: string;
	recruiterEmail: string | null;
	status: string;
	createdAt: string;
	lastSyncedAt: string | null;
};

export type SyncCommentsResult = {
	sessionId: string;
	docId: string;
	scanned: number;
	inserted: number;
	updated: number;
	skippedUnmapped: number;
	resolvedRemote: number;
};

export type ReviewCommentRecord = {
	id: string;
	sessionId: string;
	docId: string;
	docUrl: string;
	resumeId: string;
	driveCommentId: string;
	jsonPath: string | null;
	anchoredText: string | null;
	commentText: string;
	authorName: string | null;
	authorEmail: string | null;
	status: "open" | "applied" | "dismissed";
	driveCreatedAt: string | null;
	syncedAt: string;
	appliedAt: string | null;
	appliedNote: string | null;
};

type StoredFieldMap = { version?: number; entries?: FieldMapEntry[] };

export type ProposeChangesResult = {
	resumeId: string;
	batchId: string;
	proposalCount: number;
	durationMs: number;
	notes: string | null;
};

export type ProposalRecord = {
	id: string;
	batchId: string;
	resumeId: string;
	title: string;
	jsonPath: string;
	before: unknown;
	after: unknown;
	reasoning: string | null;
	commentIds: string[];
	driveCommentIds: string[];
	docId: string | null;
	status: "pending" | "applied" | "discarded";
	createdAt: string;
	decidedAt: string | null;
};

export type ApplyProposalResult = {
	proposalId: string;
	resumeId: string;
	commentsResolvedOnDrive: number;
};

export type ResetProposalsResult = {
	resumeId: string;
	proposalsReset: number;
	commentsReopened: number;
};

function getResumeForUser(resumeId: string, userId: string) {
	return db
		.select({
			id: schema.resume.id,
			name: schema.resume.name,
			data: schema.resume.data,
			userId: schema.resume.userId,
		})
		.from(schema.resume)
		.where(and(eq(schema.resume.id, resumeId), eq(schema.resume.userId, userId)))
		.limit(1);
}

async function generateAndUploadPdf(input: {
	resume: { id: string; userId: string; data: ResumeData };
	accessToken: string;
	existingDriveFileId: string | null;
	pdfName: string;
}): Promise<{ driveFileId: string; driveUrl: string } | null> {
	let pdfBytes: Buffer;
	try {
		const pdfStorageUrl = await printerService.printResumeAsPDF(input.resume);
		const fetched = await fetch(pdfStorageUrl);
		if (!fetched.ok) throw new Error(`PDF storage fetch returned ${fetched.status}`);
		pdfBytes = Buffer.from(await fetched.arrayBuffer());
	} catch (err) {
		logger.warn("PDF generation/fetch failed; skipping PDF for review", { error: err });
		return null;
	}

	if (input.existingDriveFileId) {
		try {
			const updated = await updateDriveFileMedia(input.accessToken, input.existingDriveFileId, {
				mimeType: "application/pdf",
				data: pdfBytes,
			});
			return {
				driveFileId: updated.id,
				driveUrl: updated.webViewLink ?? buildDriveFileUrl(updated.id),
			};
		} catch (err) {
			if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
				logger.info("Existing PDF Drive file gone; will create a new one", {
					fileId: input.existingDriveFileId,
				});
			} else {
				throw err;
			}
		}
	}

	const created = await createDriveFile(input.accessToken, {
		name: input.pdfName,
		mimeType: "application/pdf",
		data: pdfBytes,
	});
	return {
		driveFileId: created.id,
		driveUrl: created.webViewLink ?? buildDriveFileUrl(created.id),
	};
}

function buildDocTitle(resumeName: string, basicsName: string | undefined): string {
	const owner = basicsName?.trim() || resumeName.trim() || "Resume";
	const timestamp = new Date().toISOString().slice(0, 10);
	return `Resume Review — ${owner} (${timestamp})`;
}

/**
 * Called after a proposal is applied or discarded. For each comment this proposal touches,
 * check whether every proposal referencing that comment has now been decided. If so:
 *  - mark the local comment as "applied" (if any of its proposals was applied) or "dismissed" (all discarded)
 */
async function maybeFinalizeComments(input: {
	resumeId: string;
	commentIds: string[];
}): Promise<void> {
	if (input.commentIds.length === 0) return;

	for (const commentId of input.commentIds) {
		// drizzle pg doesn't have a clean array-contains here, so filter in JS using a fresh lookup.
		const allProposals = await db
			.select({
				id: schema.resumeCodexProposal.id,
				title: schema.resumeCodexProposal.title,
				status: schema.resumeCodexProposal.status,
				jsonPath: schema.resumeCodexProposal.jsonPath,
				commentIds: schema.resumeCodexProposal.commentIds,
			})
			.from(schema.resumeCodexProposal)
			.where(eq(schema.resumeCodexProposal.resumeId, input.resumeId));
		const proposalsForComment = allProposals.filter((p) => p.commentIds.includes(commentId));
		if (proposalsForComment.length === 0) continue;
		const stillPending = proposalsForComment.filter((p) => p.status === "pending");
		if (stillPending.length > 0) continue;

		const applied = proposalsForComment.filter((p) => p.status === "applied");
		const newStatus: "applied" | "dismissed" = applied.length > 0 ? "applied" : "dismissed";
		const now = new Date();
		const summary = proposalsForComment
			.map((p) => `• ${p.status === "applied" ? "✅" : "✖"} ${p.title} (${p.jsonPath})`)
			.join("\n");
		const replyText =
			newStatus === "applied"
				? `Codex proposals processed on ${now.toISOString().slice(0, 16).replace("T", " ")} UTC:\n${summary}`
				: `Codex proposals dismissed on ${now.toISOString().slice(0, 16).replace("T", " ")} UTC:\n${summary}`;

		await db
			.update(schema.resumeReviewComment)
			.set({ status: newStatus, appliedAt: now, appliedNote: replyText })
			.where(eq(schema.resumeReviewComment.id, commentId));
	}
}

export const googleDocsService = {
	getStatus: async (userId: string): Promise<GoogleDocsStatus> => {
		const configured = isGoogleDocsConfigured();
		if (!configured) {
			return {
				configured: false,
				connected: false,
				googleEmail: null,
				scopes: [],
				connectedAt: null,
				expiresAt: null,
				missingScopes: [...GOOGLE_DOCS_SCOPES],
			};
		}

		const connection = await getConnection(userId);
		if (!connection) {
			return {
				configured: true,
				connected: false,
				googleEmail: null,
				scopes: [],
				connectedAt: null,
				expiresAt: null,
				missingScopes: [...GOOGLE_DOCS_SCOPES],
			};
		}

		const grantedScopes = connection.scope.split(/\s+/).filter(Boolean);
		const grantedSet = new Set(grantedScopes);
		const missingScopes = GOOGLE_DOCS_SCOPES.filter((scope) => !grantedSet.has(scope));

		return {
			configured: true,
			connected: true,
			googleEmail: connection.googleEmail,
			scopes: grantedScopes,
			connectedAt: connection.createdAt.toISOString(),
			expiresAt: connection.expiresAt.toISOString(),
			missingScopes,
		};
	},

	disconnect: async (userId: string): Promise<void> => {
		await disconnectConnection(userId);
	},

	publishForReview: async (input: {
		userId: string;
		resumeId: string;
		recruiterEmail?: string;
		notifyRecruiter?: boolean;
		message?: string;
	}): Promise<PublishForReviewResult> => {
		const [resume] = await getResumeForUser(input.resumeId, input.userId);
		if (!resume) throw new ORPCError("NOT_FOUND", { message: "Resume not found" });

		let accessToken: string;
		try {
			accessToken = await getAccessToken(input.userId);
		} catch (err) {
			if (err instanceof GoogleDocsNotConnectedError) {
				throw new ORPCError("PRECONDITION_FAILED", { message: "Google Docs is not connected" });
			}
			throw err;
		}

		const title = buildDocTitle(resume.name, resume.data.basics?.name);
		const pdfName = `${title}.pdf`;

		const [existing] = await db
			.select()
			.from(schema.resumeReviewSession)
			.where(
				and(
					eq(schema.resumeReviewSession.resumeId, input.resumeId),
					eq(schema.resumeReviewSession.userId, input.userId),
					eq(schema.resumeReviewSession.status, "open"),
				),
			)
			.orderBy(desc(schema.resumeReviewSession.createdAt))
			.limit(1);

		const pdfResult = await generateAndUploadPdf({
			resume: { id: resume.id, userId: resume.userId, data: resume.data },
			accessToken,
			existingDriveFileId: existing?.pdfDriveFileId ?? null,
			pdfName,
		});

		const { requests, fieldMap, plainText } = renderResumeToDoc(resume.data, {
			pdfUrl: pdfResult?.driveUrl,
		});
		const fieldMapEntries: FieldMapEntry[] = fieldMap;
		const fieldMapPayload = {
			version: 1,
			title,
			plainTextLength: plainText.length,
			entries: fieldMapEntries,
		};

		const tryUpdateExisting = async (): Promise<PublishForReviewResult | null> => {
			if (!existing) return null;
			let doc;
			try {
				doc = await getDocument(accessToken, existing.docId);
			} catch (err) {
				if (err instanceof GoogleApiError && (err.status === 404 || err.status === 403)) {
					await db
						.update(schema.resumeReviewSession)
						.set({ status: "closed" })
						.where(eq(schema.resumeReviewSession.id, existing.id));
					if (existing.pdfDriveFileId) {
						await deleteDriveFile(accessToken, existing.pdfDriveFileId).catch(() => null);
					}
					return null;
				}
				throw err;
			}

			const endIndex = getBodyEndIndex(doc);
			// Strip any list/bullet state and reset paragraph style on existing paragraphs
			// before wiping the body — otherwise the surviving trailing paragraph keeps its
			// bullet/heading style and every newly-inserted paragraph inherits it.
			const cleanupEnd = Math.max(2, endIndex);
			const cleanupRequests = [
				{ deleteParagraphBullets: { range: { startIndex: 1, endIndex: cleanupEnd } } },
				{
					updateParagraphStyle: {
						range: { startIndex: 1, endIndex: cleanupEnd },
						paragraphStyle: {
							namedStyleType: "NORMAL_TEXT",
							borderBottom: {
								color: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
								width: { magnitude: 0, unit: "PT" },
								padding: { magnitude: 0, unit: "PT" },
								dashStyle: "SOLID",
							},
							spaceAbove: { magnitude: 0, unit: "PT" },
							spaceBelow: { magnitude: 0, unit: "PT" },
							indentFirstLine: { magnitude: 0, unit: "PT" },
							indentStart: { magnitude: 0, unit: "PT" },
							indentEnd: { magnitude: 0, unit: "PT" },
						},
						fields: "namedStyleType,borderBottom,spaceAbove,spaceBelow,indentFirstLine,indentStart,indentEnd",
					},
				},
				{
					updateTextStyle: {
						range: { startIndex: 1, endIndex: cleanupEnd },
						textStyle: {
							bold: false,
							italic: false,
							underline: false,
							foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
						},
						fields: "bold,italic,underline,foregroundColor",
					},
				},
			];
			const deleteRequests =
				endIndex > 2
					? [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }]
					: [];
			const batchRequests = [...cleanupRequests, ...deleteRequests, ...requests];
			if (batchRequests.length > 0) {
				await batchUpdate(accessToken, existing.docId, batchRequests);
			}

			let shared = Boolean(existing.recruiterEmail);
			let shareError: string | null = null;
			const targetEmail = input.recruiterEmail ?? existing.recruiterEmail ?? undefined;
			const emailChanged =
				input.recruiterEmail && input.recruiterEmail !== existing.recruiterEmail;
			if (input.recruiterEmail && emailChanged) {
				try {
					await shareFileWithEmail(accessToken, existing.docId, input.recruiterEmail, "commenter", {
						sendNotificationEmail: input.notifyRecruiter ?? true,
						emailMessage: input.message,
					});
					if (pdfResult) {
						await shareFileWithEmail(accessToken, pdfResult.driveFileId, input.recruiterEmail, "reader", {
							sendNotificationEmail: false,
						}).catch((err) => logger.warn("PDF share failed (non-fatal)", { error: err }));
					}
					shared = true;
				} catch (err) {
					shareError = err instanceof GoogleApiError ? err.message : "Failed to share document";
					logger.warn("Google Docs share failed", {
						userId: input.userId,
						docId: existing.docId,
						recruiterEmail: input.recruiterEmail,
						error: err,
					});
				}
			}

			await db
				.update(schema.resumeReviewSession)
				.set({
					fieldMap: fieldMapPayload,
					recruiterEmail: targetEmail ?? null,
					pdfDriveFileId: pdfResult?.driveFileId ?? existing.pdfDriveFileId ?? null,
					pdfDriveUrl: pdfResult?.driveUrl ?? existing.pdfDriveUrl ?? null,
					lastSyncedAt: new Date(),
				})
				.where(eq(schema.resumeReviewSession.id, existing.id));

			logger.info("Resume review session updated in place", {
				userId: input.userId,
				resumeId: input.resumeId,
				docId: existing.docId,
				fieldMapSize: fieldMapEntries.length,
				pdfDriveFileId: pdfResult?.driveFileId,
			});

			return {
				sessionId: existing.id,
				docId: existing.docId,
				docUrl: existing.docUrl,
				fieldMapSize: fieldMapEntries.length,
				shared,
				shareError,
				reused: true,
			};
		};

		const updated = await tryUpdateExisting();
		if (updated) return updated;

		const doc = await createDocument(accessToken, title);

		if (requests.length > 0) {
			await batchUpdate(accessToken, doc.documentId, requests);
		}

		let shared = false;
		let shareError: string | null = null;
		if (input.recruiterEmail) {
			try {
				await shareFileWithEmail(accessToken, doc.documentId, input.recruiterEmail, "commenter", {
					sendNotificationEmail: input.notifyRecruiter ?? true,
					emailMessage: input.message,
				});
				if (pdfResult) {
					await shareFileWithEmail(accessToken, pdfResult.driveFileId, input.recruiterEmail, "reader", {
						sendNotificationEmail: false,
					}).catch((err) => logger.warn("PDF share failed (non-fatal)", { error: err }));
				}
				shared = true;
			} catch (err) {
				shareError = err instanceof GoogleApiError ? err.message : "Failed to share document";
				logger.warn("Google Docs share failed", {
					userId: input.userId,
					docId: doc.documentId,
					recruiterEmail: input.recruiterEmail,
					error: err,
				});
			}
		}

		const docUrl = buildDocumentUrl(doc.documentId);

		const [session] = await db
			.insert(schema.resumeReviewSession)
			.values({
				resumeId: input.resumeId,
				userId: input.userId,
				docId: doc.documentId,
				docUrl,
				recruiterEmail: input.recruiterEmail ?? null,
				fieldMap: fieldMapPayload,
				pdfDriveFileId: pdfResult?.driveFileId ?? null,
				pdfDriveUrl: pdfResult?.driveUrl ?? null,
				status: "open",
			})
			.returning({ id: schema.resumeReviewSession.id });

		logger.info("Resume review session published", {
			userId: input.userId,
			resumeId: input.resumeId,
			docId: doc.documentId,
			fieldMapSize: fieldMapEntries.length,
			shared,
		});

		return {
			sessionId: session.id,
			docId: doc.documentId,
			docUrl,
			fieldMapSize: fieldMapEntries.length,
			shared,
			shareError,
			reused: false,
		};
	},

	listReviewSessions: async (input: { userId: string; resumeId?: string }): Promise<ReviewSessionSummary[]> => {
		const where = input.resumeId
			? and(eq(schema.resumeReviewSession.userId, input.userId), eq(schema.resumeReviewSession.resumeId, input.resumeId))
			: eq(schema.resumeReviewSession.userId, input.userId);

		const rows = await db
			.select({
				id: schema.resumeReviewSession.id,
				resumeId: schema.resumeReviewSession.resumeId,
				docId: schema.resumeReviewSession.docId,
				docUrl: schema.resumeReviewSession.docUrl,
				recruiterEmail: schema.resumeReviewSession.recruiterEmail,
				status: schema.resumeReviewSession.status,
				createdAt: schema.resumeReviewSession.createdAt,
				lastSyncedAt: schema.resumeReviewSession.lastSyncedAt,
			})
			.from(schema.resumeReviewSession)
			.where(where);

		return rows.map((row) => ({
			id: row.id,
			resumeId: row.resumeId,
			docId: row.docId,
			docUrl: row.docUrl,
			recruiterEmail: row.recruiterEmail,
			status: row.status,
			createdAt: row.createdAt.toISOString(),
			lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
		}));
	},

	syncComments: async (input: { userId: string; sessionId?: string; resumeId?: string }): Promise<SyncCommentsResult[]> => {
		const conditions = [eq(schema.resumeReviewSession.userId, input.userId), eq(schema.resumeReviewSession.status, "open")];
		if (input.sessionId) conditions.push(eq(schema.resumeReviewSession.id, input.sessionId));
		if (input.resumeId) conditions.push(eq(schema.resumeReviewSession.resumeId, input.resumeId));

		const sessions = await db
			.select()
			.from(schema.resumeReviewSession)
			.where(and(...conditions));

		if (sessions.length === 0) return [];

		let accessToken: string;
		try {
			accessToken = await getAccessToken(input.userId);
		} catch (err) {
			if (err instanceof GoogleDocsNotConnectedError) {
				throw new ORPCError("PRECONDITION_FAILED", { message: "Google Docs is not connected" });
			}
			throw err;
		}

		const results: SyncCommentsResult[] = [];

		for (const session of sessions) {
			const fieldMap = (session.fieldMap as StoredFieldMap | null) ?? null;
			const entries = fieldMap?.entries ?? [];

			let driveComments: DriveComment[];
			try {
				driveComments = await listComments(accessToken, session.docId);
			} catch (err) {
				if (err instanceof GoogleApiError && (err.status === 404 || err.status === 403)) {
					await db
						.update(schema.resumeReviewSession)
						.set({ status: "closed" })
						.where(eq(schema.resumeReviewSession.id, session.id));
					continue;
				}
				throw err;
			}

			const existingRows = await db
				.select({
					id: schema.resumeReviewComment.id,
					driveCommentId: schema.resumeReviewComment.driveCommentId,
					status: schema.resumeReviewComment.status,
				})
				.from(schema.resumeReviewComment)
				.where(eq(schema.resumeReviewComment.sessionId, session.id));
			const existingByDriveId = new Map(existingRows.map((r) => [r.driveCommentId, r]));

			let inserted = 0;
			let updated = 0;
			let skippedUnmapped = 0;

			for (const comment of driveComments) {
				if (comment.resolved) continue;
				const parsed = parseDriveAnchor(comment.anchor);
				const match = parsed ? findBestFieldMatch(entries, parsed) : null;
				if (!match) skippedUnmapped += 1;

				const anchoredText = comment.quotedFileContent?.value ?? null;
				const payload = {
					jsonPath: match?.jsonPath ?? null,
					anchoredText,
					commentText: comment.content,
					authorName: comment.author?.displayName ?? null,
					authorEmail: comment.author?.emailAddress ?? null,
					driveCreatedAt: comment.createdTime ? new Date(comment.createdTime) : null,
					syncedAt: new Date(),
				};

				const existing = existingByDriveId.get(comment.id);
				if (existing) {
					await db
						.update(schema.resumeReviewComment)
						.set(payload)
						.where(eq(schema.resumeReviewComment.id, existing.id));
					updated += 1;
				} else {
					await db.insert(schema.resumeReviewComment).values({
						sessionId: session.id,
						driveCommentId: comment.id,
						status: "open",
						...payload,
					});
					inserted += 1;
				}
			}

			await db
				.update(schema.resumeReviewSession)
				.set({ lastSyncedAt: new Date() })
				.where(eq(schema.resumeReviewSession.id, session.id));

			results.push({
				sessionId: session.id,
				docId: session.docId,
				scanned: driveComments.length,
				inserted,
				updated,
				skippedUnmapped,
				resolvedRemote: 0,
			});

			logger.info("Synced Google Docs comments", {
				userId: input.userId,
				sessionId: session.id,
				docId: session.docId,
				scanned: driveComments.length,
				inserted,
				updated,
				skippedUnmapped,
			});
		}

		return results;
	},

	listComments: async (input: { userId: string; resumeId?: string; status?: "open" | "applied" | "dismissed" }): Promise<ReviewCommentRecord[]> => {
		const conditions = [eq(schema.resumeReviewSession.userId, input.userId)];
		if (input.resumeId) conditions.push(eq(schema.resumeReviewSession.resumeId, input.resumeId));

		const rows = await db
			.select({
				id: schema.resumeReviewComment.id,
				sessionId: schema.resumeReviewComment.sessionId,
				docId: schema.resumeReviewSession.docId,
				docUrl: schema.resumeReviewSession.docUrl,
				resumeId: schema.resumeReviewSession.resumeId,
				driveCommentId: schema.resumeReviewComment.driveCommentId,
				jsonPath: schema.resumeReviewComment.jsonPath,
				anchoredText: schema.resumeReviewComment.anchoredText,
				commentText: schema.resumeReviewComment.commentText,
				authorName: schema.resumeReviewComment.authorName,
				authorEmail: schema.resumeReviewComment.authorEmail,
				status: schema.resumeReviewComment.status,
				driveCreatedAt: schema.resumeReviewComment.driveCreatedAt,
				syncedAt: schema.resumeReviewComment.syncedAt,
				appliedAt: schema.resumeReviewComment.appliedAt,
				appliedNote: schema.resumeReviewComment.appliedNote,
			})
			.from(schema.resumeReviewComment)
			.innerJoin(
				schema.resumeReviewSession,
				eq(schema.resumeReviewComment.sessionId, schema.resumeReviewSession.id),
			)
			.where(
				input.status
					? and(...conditions, eq(schema.resumeReviewComment.status, input.status))
					: and(...conditions),
			)
			.orderBy(desc(schema.resumeReviewComment.driveCreatedAt));

		return rows.map((row) => ({
			id: row.id,
			sessionId: row.sessionId,
			docId: row.docId,
			docUrl: row.docUrl,
			resumeId: row.resumeId,
			driveCommentId: row.driveCommentId,
			jsonPath: row.jsonPath,
			anchoredText: row.anchoredText,
			commentText: row.commentText,
			authorName: row.authorName,
			authorEmail: row.authorEmail,
			status: row.status as ReviewCommentRecord["status"],
			driveCreatedAt: row.driveCreatedAt?.toISOString() ?? null,
			syncedAt: row.syncedAt.toISOString(),
			appliedAt: row.appliedAt?.toISOString() ?? null,
			appliedNote: row.appliedNote,
		}));
	},

	proposeCodexChanges: async (input: { userId: string; resumeId: string }): Promise<{
		batchId: string;
		proposalsCreated: number;
		notes: string | null;
		durationMs: number;
	}> => {
		const [resume] = await getResumeForUser(input.resumeId, input.userId);
		if (!resume) throw new ORPCError("NOT_FOUND", { message: "Resume not found" });

		const commentRows = await db
			.select({
				id: schema.resumeReviewComment.id,
				driveCommentId: schema.resumeReviewComment.driveCommentId,
				docId: schema.resumeReviewSession.docId,
				jsonPath: schema.resumeReviewComment.jsonPath,
				anchoredText: schema.resumeReviewComment.anchoredText,
				commentText: schema.resumeReviewComment.commentText,
				authorName: schema.resumeReviewComment.authorName,
			})
			.from(schema.resumeReviewComment)
			.innerJoin(
				schema.resumeReviewSession,
				eq(schema.resumeReviewComment.sessionId, schema.resumeReviewSession.id),
			)
			.where(
				and(
					eq(schema.resumeReviewSession.userId, input.userId),
					eq(schema.resumeReviewSession.resumeId, input.resumeId),
					eq(schema.resumeReviewComment.status, "open"),
				),
			);

		if (commentRows.length === 0) {
			throw new ORPCError("BAD_REQUEST", { message: "No open comments to propose changes for" });
		}

		const commentById = new Map(commentRows.map((r) => [r.id, r]));

		const commentsForCodex: CommentForCodex[] = commentRows.map((r) => ({
			id: r.id,
			jsonPath: r.jsonPath,
			anchoredText: r.anchoredText,
			commentText: r.commentText,
			authorName: r.authorName,
		}));

		let codexOutput;
		try {
			codexOutput = await runCodexProposals({ resume: resume.data, comments: commentsForCodex });
		} catch (err) {
			if (err instanceof CodexRunError) {
				logger.error("Codex proposal run failed", {
					stage: err.stage,
					stderr: err.stderr?.slice(0, 800),
					stdout: err.stdout?.slice(0, 800),
				});
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Codex ${err.stage} failed: ${err.message}`.slice(0, 500),
				});
			}
			throw err;
		}

		// Wipe any prior pending/applied proposals for this resume — only the latest batch is active.
		await db
			.delete(schema.resumeCodexProposal)
			.where(eq(schema.resumeCodexProposal.resumeId, input.resumeId));

		// Snapshot resume.data so resetCodexProposals can revert applied proposals later.
		await db
			.insert(schema.resumeCodexUndo)
			.values({
				resumeId: input.resumeId,
				userId: input.userId,
				previousData: resume.data,
				appliedCommentIds: [],
				driveCommentIds: [],
				docId: commentRows[0]?.docId ?? null,
			})
			.onConflictDoUpdate({
				target: schema.resumeCodexUndo.resumeId,
				set: {
					previousData: resume.data,
					appliedCommentIds: [],
					driveCommentIds: [],
					docId: commentRows[0]?.docId ?? null,
				},
			});

		const batchId = randomUUID();
		let inserted = 0;
		for (const p of codexOutput.proposals) {
			const commentIds = p.commentIds.filter((id) => commentById.has(id));
			if (commentIds.length === 0) continue;
			const driveCommentIds = commentIds
				.map((id) => commentById.get(id)?.driveCommentId)
				.filter((v): v is string => Boolean(v));
			const docId = commentById.get(commentIds[0])?.docId ?? null;
			// Use the actual current resume value for `before` so we don't trust Codex's echo.
			const actualBefore = get(resume.data as unknown as object, p.jsonPath) ?? null;
			await db.insert(schema.resumeCodexProposal).values({
				resumeId: input.resumeId,
				userId: input.userId,
				batchId,
				title: p.title.slice(0, 280),
				jsonPath: p.jsonPath,
				beforeValue: actualBefore as unknown,
				afterValue: p.after as unknown,
				reasoning: p.reasoning ?? null,
				commentIds,
				driveCommentIds,
				docId,
				status: "pending",
			});
			inserted += 1;
		}

		logger.info("Codex produced proposals", {
			userId: input.userId,
			resumeId: input.resumeId,
			batchId,
			proposalsCreated: inserted,
			durationMs: codexOutput.durationMs,
			notes: codexOutput.notes,
		});

		return {
			batchId,
			proposalsCreated: inserted,
			notes: codexOutput.notes,
			durationMs: codexOutput.durationMs,
		};
	},

	listProposals: async (input: { userId: string; resumeId: string }) => {
		const rows = await db
			.select()
			.from(schema.resumeCodexProposal)
			.where(
				and(
					eq(schema.resumeCodexProposal.resumeId, input.resumeId),
					eq(schema.resumeCodexProposal.userId, input.userId),
				),
			)
			.orderBy(desc(schema.resumeCodexProposal.createdAt));

		return rows.map((row) => ({
			id: row.id,
			batchId: row.batchId,
			title: row.title,
			jsonPath: row.jsonPath,
			beforeValue: row.beforeValue,
			afterValue: row.afterValue,
			reasoning: row.reasoning,
			commentIds: row.commentIds,
			status: row.status as "pending" | "applied" | "discarded",
			decidedAt: row.decidedAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
		}));
	},

	applyProposal: async (input: { userId: string; proposalId: string }) => {
		const [proposal] = await db
			.select()
			.from(schema.resumeCodexProposal)
			.where(
				and(
					eq(schema.resumeCodexProposal.id, input.proposalId),
					eq(schema.resumeCodexProposal.userId, input.userId),
				),
			)
			.limit(1);
		if (!proposal) throw new ORPCError("NOT_FOUND");
		if (proposal.status !== "pending") {
			throw new ORPCError("BAD_REQUEST", { message: `Proposal is already ${proposal.status}` });
		}

		const [resume] = await getResumeForUser(proposal.resumeId, input.userId);
		if (!resume) throw new ORPCError("NOT_FOUND", { message: "Resume not found" });

		// Apply the change to resume.data
		const next = structuredClone(resume.data);
		set(next as unknown as object, proposal.jsonPath, proposal.afterValue as unknown);
		await db
			.update(schema.resume)
			.set({ data: next })
			.where(and(eq(schema.resume.id, proposal.resumeId), eq(schema.resume.userId, input.userId)));

		await db
			.update(schema.resumeCodexProposal)
			.set({ status: "applied", decidedAt: new Date() })
			.where(eq(schema.resumeCodexProposal.id, proposal.id));

		await maybeFinalizeComments({
			resumeId: proposal.resumeId,
			commentIds: proposal.commentIds,
		});

		return { proposalId: proposal.id, status: "applied" as const };
	},

	discardProposal: async (input: { userId: string; proposalId: string }) => {
		const [proposal] = await db
			.select()
			.from(schema.resumeCodexProposal)
			.where(
				and(
					eq(schema.resumeCodexProposal.id, input.proposalId),
					eq(schema.resumeCodexProposal.userId, input.userId),
				),
			)
			.limit(1);
		if (!proposal) throw new ORPCError("NOT_FOUND");
		if (proposal.status !== "pending") {
			throw new ORPCError("BAD_REQUEST", { message: `Proposal is already ${proposal.status}` });
		}

		await db
			.update(schema.resumeCodexProposal)
			.set({ status: "discarded", decidedAt: new Date() })
			.where(eq(schema.resumeCodexProposal.id, proposal.id));

		await maybeFinalizeComments({
			resumeId: proposal.resumeId,
			commentIds: proposal.commentIds,
		});

		return { proposalId: proposal.id, status: "discarded" as const };
	},

	resetCodexProposals: async (input: { userId: string; resumeId: string }) => {
		const [undo] = await db
			.select()
			.from(schema.resumeCodexUndo)
			.where(
				and(
					eq(schema.resumeCodexUndo.resumeId, input.resumeId),
					eq(schema.resumeCodexUndo.userId, input.userId),
				),
			)
			.limit(1);

		const proposals = await db
			.select({
				id: schema.resumeCodexProposal.id,
				status: schema.resumeCodexProposal.status,
				commentIds: schema.resumeCodexProposal.commentIds,
			})
			.from(schema.resumeCodexProposal)
			.where(
				and(
					eq(schema.resumeCodexProposal.resumeId, input.resumeId),
					eq(schema.resumeCodexProposal.userId, input.userId),
				),
			);

		if (undo) {
			await db
				.update(schema.resume)
				.set({ data: undo.previousData })
				.where(and(eq(schema.resume.id, input.resumeId), eq(schema.resume.userId, input.userId)));
		}

		const allCommentIds = Array.from(new Set(proposals.flatMap((p) => p.commentIds)));
		if (allCommentIds.length > 0) {
			await db
				.update(schema.resumeReviewComment)
				.set({ status: "open", appliedAt: null, appliedNote: null })
				.where(inArray(schema.resumeReviewComment.id, allCommentIds));
		}

		await db
			.delete(schema.resumeCodexProposal)
			.where(eq(schema.resumeCodexProposal.resumeId, input.resumeId));
		await db
			.delete(schema.resumeCodexUndo)
			.where(eq(schema.resumeCodexUndo.resumeId, input.resumeId));

		return { resumeId: input.resumeId, proposalsCleared: proposals.length };
	},

	resolveCommentAction: async (input: {
		userId: string;
		commentId: string;
		action: "applied" | "dismissed";
		note?: string;
	}): Promise<void> => {
		const [row] = await db
			.select({
				id: schema.resumeReviewComment.id,
				userId: schema.resumeReviewSession.userId,
			})
			.from(schema.resumeReviewComment)
			.innerJoin(
				schema.resumeReviewSession,
				eq(schema.resumeReviewComment.sessionId, schema.resumeReviewSession.id),
			)
			.where(eq(schema.resumeReviewComment.id, input.commentId))
			.limit(1);

		if (!row || row.userId !== input.userId) throw new ORPCError("NOT_FOUND");

		const appliedNote =
			input.action === "applied"
				? input.note?.trim() || "Applied — thank you for the feedback!"
				: input.note?.trim() || "Acknowledged.";

		await db
			.update(schema.resumeReviewComment)
			.set({
				status: input.action,
				appliedAt: new Date(),
				appliedNote,
			})
			.where(eq(schema.resumeReviewComment.id, input.commentId));
	},

	updateSessionSharing: async (input: {
		userId: string;
		resumeId: string;
		recruiterEmail?: string;
		notifyRecruiter?: boolean;
		message?: string;
	}): Promise<{ resumeId: string; shared: boolean; shareError: string | null }> => {
		const [existing] = await db
			.select()
			.from(schema.resumeReviewSession)
			.where(
				and(
					eq(schema.resumeReviewSession.resumeId, input.resumeId),
					eq(schema.resumeReviewSession.userId, input.userId),
					eq(schema.resumeReviewSession.status, "open"),
				),
			)
			.orderBy(desc(schema.resumeReviewSession.createdAt))
			.limit(1);
		if (!existing) throw new ORPCError("NOT_FOUND", { message: "No active review session for this resume" });

		const trimmed = input.recruiterEmail?.trim() ?? "";
		const newEmail = trimmed.length > 0 ? trimmed : null;
		const emailChanged = newEmail !== null && newEmail !== existing.recruiterEmail;

		let shared = false;
		let shareError: string | null = null;

		if (emailChanged) {
			try {
				const accessToken = await getAccessToken(input.userId);
				await shareFileWithEmail(accessToken, existing.docId, newEmail, "commenter", {
					sendNotificationEmail: input.notifyRecruiter ?? false,
					emailMessage: input.message,
				});
				if (existing.pdfDriveFileId) {
					await shareFileWithEmail(accessToken, existing.pdfDriveFileId, newEmail, "reader", {
						sendNotificationEmail: false,
					}).catch((err) => logger.warn("PDF share failed (non-fatal)", { error: err }));
				}
				shared = true;
			} catch (err) {
				shareError = err instanceof GoogleApiError ? err.message : "Failed to share document";
				logger.warn("updateSessionSharing share failed", {
					userId: input.userId,
					docId: existing.docId,
					recruiterEmail: newEmail,
					error: err,
				});
			}
		}

		await db
			.update(schema.resumeReviewSession)
			.set({ recruiterEmail: newEmail ?? existing.recruiterEmail })
			.where(eq(schema.resumeReviewSession.id, existing.id));

		logger.info("Updated review-session sharing (no content re-render)", {
			userId: input.userId,
			resumeId: input.resumeId,
			emailChanged,
			shared,
		});

		return { resumeId: input.resumeId, shared, shareError };
	},

	deleteCommentRecord: async (input: { userId: string; commentId: string }): Promise<void> => {
		const [row] = await db
			.select({
				id: schema.resumeReviewComment.id,
				userId: schema.resumeReviewSession.userId,
			})
			.from(schema.resumeReviewComment)
			.innerJoin(
				schema.resumeReviewSession,
				eq(schema.resumeReviewComment.sessionId, schema.resumeReviewSession.id),
			)
			.where(eq(schema.resumeReviewComment.id, input.commentId))
			.limit(1);

		if (!row || row.userId !== input.userId) throw new ORPCError("NOT_FOUND");

		await db.delete(schema.resumeReviewComment).where(eq(schema.resumeReviewComment.id, input.commentId));
	},
};
