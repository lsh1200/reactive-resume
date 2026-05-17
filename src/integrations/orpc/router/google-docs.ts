import z from "zod";
import { protectedProcedure } from "../context";
import { googleDocsService } from "../services/google-docs";

const statusSchema = z.object({
	configured: z.boolean(),
	connected: z.boolean(),
	googleEmail: z.string().nullable(),
	scopes: z.array(z.string()),
	connectedAt: z.string().nullable(),
	expiresAt: z.string().nullable(),
	missingScopes: z.array(z.string()),
});

const publishResultSchema = z.object({
	sessionId: z.string(),
	docId: z.string(),
	docUrl: z.string(),
	fieldMapSize: z.number(),
	shared: z.boolean(),
	shareError: z.string().nullable(),
	reused: z.boolean(),
});

const reviewSessionSchema = z.object({
	id: z.string(),
	resumeId: z.string(),
	docId: z.string(),
	docUrl: z.string(),
	recruiterEmail: z.string().nullable(),
	status: z.string(),
	createdAt: z.string(),
	lastSyncedAt: z.string().nullable(),
});

const syncResultSchema = z.object({
	sessionId: z.string(),
	docId: z.string(),
	scanned: z.number(),
	inserted: z.number(),
	updated: z.number(),
	skippedUnmapped: z.number(),
	resolvedRemote: z.number(),
});

const commentSchema = z.object({
	id: z.string(),
	sessionId: z.string(),
	docId: z.string(),
	docUrl: z.string(),
	resumeId: z.string(),
	driveCommentId: z.string(),
	jsonPath: z.string().nullable(),
	anchoredText: z.string().nullable(),
	commentText: z.string(),
	authorName: z.string().nullable(),
	authorEmail: z.string().nullable(),
	status: z.enum(["open", "applied", "dismissed"]),
	driveCreatedAt: z.string().nullable(),
	syncedAt: z.string(),
	appliedAt: z.string().nullable(),
	appliedNote: z.string().nullable(),
});

export const googleDocsRouter = {
	getStatus: protectedProcedure
		.route({
			method: "GET",
			path: "/google-docs/status",
			tags: ["Google Docs"],
			operationId: "getGoogleDocsStatus",
			summary: "Get Google Docs connection status",
			description:
				"Returns whether the authenticated user has connected their Google account for the Docs review flow, including the granted Google email and OAuth scopes. Requires authentication.",
			successDescription: "The current Google Docs connection status for the authenticated user.",
		})
		.output(statusSchema)
		.handler(async ({ context }) => {
			return await googleDocsService.getStatus(context.user.id);
		}),

	disconnect: protectedProcedure
		.route({
			method: "DELETE",
			path: "/google-docs/connection",
			tags: ["Google Docs"],
			operationId: "disconnectGoogleDocs",
			summary: "Disconnect Google Docs",
			description:
				"Revokes the stored Google OAuth tokens and removes the user's Google Docs connection. Subsequent review flows will require reconnecting. Requires authentication.",
			successDescription: "The Google Docs connection has been removed.",
		})
		.handler(async ({ context }): Promise<void> => {
			await googleDocsService.disconnect(context.user.id);
		}),

	publishForReview: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews",
			tags: ["Google Docs"],
			operationId: "publishResumeForReview",
			summary: "Export resume to a Google Doc for review",
			description:
				"Creates a new Google Doc rendered from the specified resume, optionally shares it with a recruiter as commenter, and persists a review session with a field map for mapping comments back to resume fields. Requires authentication and an active Google Docs connection.",
			successDescription: "The Google Doc was created and a review session was persisted.",
		})
		.input(
			z.object({
				resumeId: z.string().describe("The id of the resume to publish."),
				recruiterEmail: z
					.string()
					.email()
					.optional()
					.describe("Email address of the recruiter to grant comment access. Omit to keep the doc private."),
				notifyRecruiter: z
					.boolean()
					.optional()
					.describe("Whether Google should email the recruiter notifying them they have access. Default true."),
				message: z.string().optional().describe("Optional message included in the recruiter notification email."),
			}),
		)
		.output(publishResultSchema)
		.handler(async ({ context, input }) => {
			return await googleDocsService.publishForReview({
				userId: context.user.id,
				resumeId: input.resumeId,
				recruiterEmail: input.recruiterEmail,
				notifyRecruiter: input.notifyRecruiter,
				message: input.message,
			});
		}),

	syncComments: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/sync",
			tags: ["Google Docs"],
			operationId: "syncGoogleDocsReviewComments",
			summary: "Sync comments from the Google Doc",
			description:
				"Fetches comments from the Google Doc for one or all open review sessions, maps them to resume field paths via the stored field map, and upserts them into the local store. Requires authentication and an active Google Docs connection.",
			successDescription: "Sync summary per session.",
		})
		.input(
			z.object({
				sessionId: z.string().optional(),
				resumeId: z.string().optional(),
			}),
		)
		.output(z.array(syncResultSchema))
		.handler(async ({ context, input }) => {
			return await googleDocsService.syncComments({
				userId: context.user.id,
				sessionId: input.sessionId,
				resumeId: input.resumeId,
			});
		}),

	listComments: protectedProcedure
		.route({
			method: "GET",
			path: "/google-docs/reviews/comments",
			tags: ["Google Docs"],
			operationId: "listGoogleDocsReviewComments",
			summary: "List comments from review sessions",
			description:
				"Returns all stored review comments for the authenticated user, optionally filtered by resume id or status. Requires authentication.",
			successDescription: "An array of review comments.",
		})
		.input(
			z.object({
				resumeId: z.string().optional(),
				status: z.enum(["open", "applied", "dismissed"]).optional(),
			}),
		)
		.output(z.array(commentSchema))
		.handler(async ({ context, input }) => {
			return await googleDocsService.listComments({
				userId: context.user.id,
				resumeId: input.resumeId,
				status: input.status,
			});
		}),

	markCommentApplied: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/comments/{id}/apply",
			tags: ["Google Docs"],
			operationId: "markGoogleDocsCommentApplied",
			summary: "Mark a review comment as applied",
			description: "Marks the comment as applied locally. Requires authentication.",
			successDescription: "The comment was marked applied.",
		})
		.input(z.object({ id: z.string(), note: z.string().optional() }))
		.handler(async ({ context, input }): Promise<void> => {
			await googleDocsService.resolveCommentAction({
				userId: context.user.id,
				commentId: input.id,
				action: "applied",
				note: input.note,
			});
		}),

	dismissComment: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/comments/{id}/dismiss",
			tags: ["Google Docs"],
			operationId: "dismissGoogleDocsComment",
			summary: "Dismiss a review comment",
			description: "Marks the comment as dismissed locally. Requires authentication.",
			successDescription: "The comment was dismissed.",
		})
		.input(z.object({ id: z.string(), note: z.string().optional() }))
		.handler(async ({ context, input }): Promise<void> => {
			await googleDocsService.resolveCommentAction({
				userId: context.user.id,
				commentId: input.id,
				action: "dismissed",
				note: input.note,
			});
		}),

	updateSessionSharing: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/{resumeId}/sharing",
			tags: ["Google Docs"],
			operationId: "updateGoogleDocsSessionSharing",
			summary: "Update review session sharing without re-rendering the doc",
			description:
				"Adds or changes the recruiter share on the existing Google Doc (and PDF) for the resume's open review session. Does NOT re-render the doc body or replace the PDF. Use this when you only want to change who has access.",
			successDescription: "Sharing updated.",
		})
		.input(
			z.object({
				resumeId: z.string(),
				recruiterEmail: z.string().email().optional(),
				notifyRecruiter: z.boolean().optional(),
				message: z.string().optional(),
			}),
		)
		.output(z.object({ resumeId: z.string(), shared: z.boolean(), shareError: z.string().nullable() }))
		.handler(async ({ context, input }) => {
			return await googleDocsService.updateSessionSharing({
				userId: context.user.id,
				resumeId: input.resumeId,
				recruiterEmail: input.recruiterEmail,
				notifyRecruiter: input.notifyRecruiter,
				message: input.message,
			});
		}),

	deleteCommentRecord: protectedProcedure
		.route({
			method: "DELETE",
			path: "/google-docs/reviews/comments/{id}",
			tags: ["Google Docs"],
			operationId: "deleteGoogleDocsCommentRecord",
			summary: "Remove a review comment from local history",
			description:
				"Deletes the local record of a review comment without touching the Drive comment thread. Useful for clearing test/stale entries from the Applied or Dismissed history. Requires authentication.",
			successDescription: "The local record was deleted.",
		})
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }): Promise<void> => {
			await googleDocsService.deleteCommentRecord({
				userId: context.user.id,
				commentId: input.id,
			});
		}),

	proposeCodexChanges: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/{resumeId}/propose",
			tags: ["Google Docs"],
			operationId: "proposeGoogleDocsCodexChanges",
			summary: "Run Codex to propose per-comment changes (not auto-applied)",
			description:
				"Runs a headless Codex session and stores its proposed edits as pending proposals for review. Each proposal can be individually applied or discarded. Long-running.",
			successDescription: "Codex finished and proposals were stored.",
		})
		.input(z.object({ resumeId: z.string() }))
		.output(
			z.object({
				batchId: z.string(),
				proposalsCreated: z.number(),
				notes: z.string().nullable(),
				durationMs: z.number(),
			}),
		)
		.handler(async ({ context, input }) => {
			return await googleDocsService.proposeCodexChanges({
				userId: context.user.id,
				resumeId: input.resumeId,
			});
		}),

	listProposals: protectedProcedure
		.route({
			method: "GET",
			path: "/google-docs/reviews/{resumeId}/proposals",
			tags: ["Google Docs"],
			operationId: "listGoogleDocsCodexProposals",
			summary: "List Codex proposals for a resume",
			description: "Returns all proposals (pending/applied/discarded) for the specified resume. Requires authentication.",
			successDescription: "An array of proposals.",
		})
		.input(z.object({ resumeId: z.string() }))
		.output(
			z.array(
				z.object({
					id: z.string(),
					batchId: z.string(),
					title: z.string(),
					jsonPath: z.string(),
					beforeValue: z.unknown(),
					afterValue: z.unknown(),
					reasoning: z.string().nullable(),
					commentIds: z.array(z.string()),
					status: z.enum(["pending", "applied", "discarded"]),
					decidedAt: z.string().nullable(),
					createdAt: z.string(),
				}),
			),
		)
		.handler(async ({ context, input }) => {
			return await googleDocsService.listProposals({ userId: context.user.id, resumeId: input.resumeId });
		}),

	applyProposal: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/proposals/{id}/apply",
			tags: ["Google Docs"],
			operationId: "applyGoogleDocsCodexProposal",
			summary: "Apply a single Codex proposal to the resume",
			description:
				"Writes the proposed value into resume.data at the proposal's jsonPath. When all proposals for a given comment are decided, the comment is resolved on Drive with a summary reply.",
			successDescription: "Proposal applied.",
		})
		.input(z.object({ id: z.string() }))
		.output(z.object({ proposalId: z.string(), status: z.literal("applied") }))
		.handler(async ({ context, input }) => {
			return await googleDocsService.applyProposal({ userId: context.user.id, proposalId: input.id });
		}),

	discardProposal: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/proposals/{id}/discard",
			tags: ["Google Docs"],
			operationId: "discardGoogleDocsCodexProposal",
			summary: "Discard a single Codex proposal",
			description:
				"Marks the proposal as discarded without touching resume.data. When all proposals for a comment are decided, the comment is resolved on Drive with a summary reply.",
			successDescription: "Proposal discarded.",
		})
		.input(z.object({ id: z.string() }))
		.output(z.object({ proposalId: z.string(), status: z.literal("discarded") }))
		.handler(async ({ context, input }) => {
			return await googleDocsService.discardProposal({ userId: context.user.id, proposalId: input.id });
		}),

	resetCodexProposals: protectedProcedure
		.route({
			method: "POST",
			path: "/google-docs/reviews/{resumeId}/proposals/reset",
			tags: ["Google Docs"],
			operationId: "resetGoogleDocsCodexProposals",
			summary: "Reset all Codex proposals for a resume",
			description:
				"Reverts resume.data to the pre-Codex snapshot, reopens any comments that were finalized, and clears the proposals. Requires authentication.",
			successDescription: "Proposals cleared and resume restored.",
		})
		.input(z.object({ resumeId: z.string() }))
		.output(z.object({ resumeId: z.string(), proposalsCleared: z.number() }))
		.handler(async ({ context, input }) => {
			return await googleDocsService.resetCodexProposals({
				userId: context.user.id,
				resumeId: input.resumeId,
			});
		}),

	listReviewSessions: protectedProcedure
		.route({
			method: "GET",
			path: "/google-docs/reviews",
			tags: ["Google Docs"],
			operationId: "listGoogleDocsReviewSessions",
			summary: "List Google Docs review sessions",
			description:
				"Returns the authenticated user's resume review sessions. Optionally filtered to a single resume. Requires authentication.",
			successDescription: "An array of review session summaries.",
		})
		.input(z.object({ resumeId: z.string().optional() }))
		.output(z.array(reviewSessionSchema))
		.handler(async ({ context, input }) => {
			return await googleDocsService.listReviewSessions({
				userId: context.user.id,
				resumeId: input.resumeId,
			});
		}),
};
