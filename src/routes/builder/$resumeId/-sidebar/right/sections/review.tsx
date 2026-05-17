import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ArrowCounterClockwiseIcon,
	ArrowSquareOutIcon,
	CheckCircleIcon,
	CheckIcon,
	CircleNotchIcon,
	DownloadSimpleIcon,
	EyeIcon,
	EyeSlashIcon,
	GoogleLogoIcon,
	MagicWandIcon,
	PaperPlaneTiltIcon,
	TrashIcon,
	UploadSimpleIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useProposalPreviewStore } from "@/components/resume/store/proposal-preview";
import { useResumeStore } from "@/components/resume/store/resume";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "@/integrations/orpc/client";
import { SectionBase } from "../shared/section-base";

export function ReviewSectionBuilder() {
	const params = useParams({ from: "/builder/$resumeId" });
	const queryClient = useQueryClient();

	const status = useSuspenseQuery(orpc.googleDocs.getStatus.queryOptions());
	const sessions = useQuery(
		orpc.googleDocs.listReviewSessions.queryOptions({ input: { resumeId: params.resumeId } }),
	);
	const comments = useQuery(
		orpc.googleDocs.listComments.queryOptions({
			input: { resumeId: params.resumeId, status: "open" },
		}),
	);
	const historyApplied = useQuery(
		orpc.googleDocs.listComments.queryOptions({
			input: { resumeId: params.resumeId, status: "applied" },
		}),
	);
	const historyDismissed = useQuery(
		orpc.googleDocs.listComments.queryOptions({
			input: { resumeId: params.resumeId, status: "dismissed" },
		}),
	);

	const proposals = useQuery(
		orpc.googleDocs.listProposals.queryOptions({ input: { resumeId: params.resumeId } }),
	);

	const publish = useMutation(orpc.googleDocs.publishForReview.mutationOptions());
	const syncComments = useMutation(orpc.googleDocs.syncComments.mutationOptions());
	const proposeChanges = useMutation(orpc.googleDocs.proposeCodexChanges.mutationOptions());
	const applyProposal = useMutation(orpc.googleDocs.applyProposal.mutationOptions());
	const discardProposal = useMutation(orpc.googleDocs.discardProposal.mutationOptions());
	const resetProposals = useMutation(orpc.googleDocs.resetCodexProposals.mutationOptions());
	const deleteRecord = useMutation(orpc.googleDocs.deleteCommentRecord.mutationOptions());
	const updateSharing = useMutation(orpc.googleDocs.updateSessionSharing.mutationOptions());

	const onSaveSharingOnly = async () => {
		const trimmed = recruiterEmail.trim();
		if (trimmed.length === 0) {
			toast.error(t`Enter a recruiter email first.`);
			return;
		}
		const toastId = toast.loading(t`Updating sharing...`);
		try {
			const result = await updateSharing.mutateAsync({
				resumeId: params.resumeId,
				recruiterEmail: trimmed,
				notifyRecruiter: notify,
				message: message.trim().length > 0 ? message.trim() : undefined,
			});
			toast.success(result.shared ? t`Sharing updated.` : t`No change to sharing.`, { id: toastId });
			if (result.shareError) toast.warning(t`Sharing note: ${result.shareError}`);
			void sessions.refetch();
			setShowSharingForm(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Could not update sharing.`, { id: toastId });
		}
	};

	const pendingProposals = (proposals.data ?? []).filter((p) => p.status === "pending");
	const decidedProposals = (proposals.data ?? []).filter((p) => p.status !== "pending");
	const hasPendingProposals = pendingProposals.length > 0;
	const hasDecidedProposals = decidedProposals.length > 0;

	const onDeleteRecord = async (commentId: string) => {
		if (!window.confirm(t`Remove this entry from your local history? The comment thread on Google Drive is not affected.`)) {
			return;
		}
		const toastId = toast.loading(t`Removing from history...`);
		try {
			await deleteRecord.mutateAsync({ id: commentId });
			toast.success(t`Removed from history.`, { id: toastId });
			void historyApplied.refetch();
			void historyDismissed.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Could not remove.`, { id: toastId });
		}
	};

	const [recruiterEmail, setRecruiterEmail] = useState("");
	const [message, setMessage] = useState("");
	const [notify, setNotify] = useState(true);
	const [showSharingForm, setShowSharingForm] = useState(false);

	const connected = status.data?.connected ?? false;
	const configured = status.data?.configured ?? false;
	const hasSession = (sessions.data?.length ?? 0) > 0;
	const activeSession = sessions.data?.[0];
	const openComments = comments.data ?? [];
	const hasOpenComments = openComments.length > 0;

	const onConnect = () => {
		window.location.href = "/api/google-docs/start";
	};

	const onPublish = async () => {
		const trimmed = recruiterEmail.trim();
		const toastId = toast.loading(hasSession ? t`Updating Google Doc...` : t`Creating Google Doc...`);
		try {
			const result = await publish.mutateAsync({
				resumeId: params.resumeId,
				recruiterEmail: trimmed.length > 0 ? trimmed : undefined,
				notifyRecruiter: notify,
				message: message.trim().length > 0 ? message.trim() : undefined,
			});
			const verb = result.reused ? t`updated` : t`created`;
			toast.success(
				result.shared ? t`Google Doc ${verb} and shared.` : t`Google Doc ${verb}.`,
				{ id: toastId },
			);
			if (result.shareError) toast.warning(t`Sharing failed: ${result.shareError}`);
			if (!result.reused) window.open(result.docUrl, "_blank", "noopener,noreferrer");
			void sessions.refetch();
			setShowSharingForm(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Something went wrong.`, { id: toastId });
		}
	};

	const onQuickPushUpdate = async () => {
		const pendingCount = pendingProposals.length;
		if (pendingCount > 0) {
			const proceed = window.confirm(
				t`You still have ${pendingCount} pending proposal(s) — they won't be reflected on the Doc. Push anyway?`,
			);
			if (!proceed) return;
		}
		const toastId = toast.loading(t`Pushing latest resume to Google Doc...`);
		try {
			const result = await publish.mutateAsync({
				resumeId: params.resumeId,
				notifyRecruiter: false,
			});
			toast.success(t`Doc updated.`, { id: toastId });
			if (result.shareError) toast.warning(t`Sharing note: ${result.shareError}`);
			void sessions.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Something went wrong.`, { id: toastId });
		}
	};

	const onFetch = async () => {
		const toastId = toast.loading(t`Fetching comments from Google Docs...`);
		try {
			const results = await syncComments.mutateAsync({ resumeId: params.resumeId });
			const totalNew = results.reduce((sum, r) => sum + r.inserted, 0);
			const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
			const totalSkipped = results.reduce((sum, r) => sum + r.skippedUnmapped, 0);
			toast.success(
				t`Fetched ${totalNew} new, ${totalUpdated} updated${totalSkipped > 0 ? `, ${totalSkipped} unmapped` : ""}.`,
				{ id: toastId },
			);
			void comments.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Sync failed.`, { id: toastId });
		}
	};

	const refreshAll = async () => {
		await queryClient.invalidateQueries({
			queryKey: orpc.resume.getById.queryOptions({ input: { id: params.resumeId } }).queryKey,
		});
		void comments.refetch();
		void historyApplied.refetch();
		void historyDismissed.refetch();
		void proposals.refetch();
	};

	const onPropose = async () => {
		const toastId = toast.loading(t`Spawning Codex to propose changes for ${openComments.length} comment(s)...`);
		try {
			const result = await proposeChanges.mutateAsync({ resumeId: params.resumeId });
			toast.success(
				t`Codex proposed ${result.proposalsCreated} change(s) in ${Math.round(result.durationMs / 1000)}s. Review each below.`,
				{ id: toastId },
			);
			if (result.notes) toast.message(t`Codex notes`, { description: result.notes });
			await refreshAll();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Codex failed.`, { id: toastId, duration: 8000 });
		}
	};

	const onApplyProposal = async (id: string, title: string) => {
		const toastId = toast.loading(t`Applying: ${title}`);
		try {
			await applyProposal.mutateAsync({ id });
			toast.success(t`Applied.`, { id: toastId });
			await refreshAll();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Apply failed.`, { id: toastId });
		}
	};

	const onDiscardProposal = async (id: string, title: string) => {
		const toastId = toast.loading(t`Discarding: ${title}`);
		try {
			await discardProposal.mutateAsync({ id });
			toast.success(t`Discarded.`, { id: toastId });
			await refreshAll();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Discard failed.`, { id: toastId });
		}
	};

	const onResetProposals = async () => {
		if (
			!window.confirm(
				t`Reset all Codex proposals? This will restore your resume to its pre-Codex state and reopen any affected comments.`,
			)
		) {
			return;
		}
		const toastId = toast.loading(t`Resetting proposals...`);
		try {
			const result = await resetProposals.mutateAsync({ resumeId: params.resumeId });
			useProposalPreviewStore.getState().clear();
			toast.success(t`Cleared ${result.proposalsCleared} proposal(s).`, { id: toastId });
			await refreshAll();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t`Reset failed.`, { id: toastId });
		}
	};

	return (
		<SectionBase type="review" className="space-y-4">
			{!configured && (
				<div className="rounded-md border border-dashed p-4 text-muted-foreground text-sm">
					<Trans>
						Google Docs integration is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your
						environment to enable recruiter review.
					</Trans>
				</div>
			)}

			{configured && !connected && (
				<div className="space-y-3">
					<p className="text-muted-foreground text-sm">
						<Trans>
							Connect your Google account to publish this resume to a Google Doc that a recruiter can comment on.
						</Trans>
					</p>
					<Button variant="outline" onClick={onConnect} className="gap-2">
						<GoogleLogoIcon className="size-4" />
						<Trans>Connect Google Docs</Trans>
					</Button>
				</div>
			)}

			{configured && connected && (
				<div className="space-y-5">
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<CheckCircleIcon className="size-4 text-emerald-500" />
						<Trans>Connected as {status.data?.googleEmail ?? ""}</Trans>
					</div>

					{!hasSession && (
						<div className="space-y-3 rounded-md border p-3">
							<h3 className="font-medium text-sm">
								<Trans>1 · Publish for review</Trans>
							</h3>
							<div className="space-y-2">
								<Label htmlFor="recruiter-email" className="text-xs">
									<Trans>Recruiter Email (optional)</Trans>
								</Label>
								<Input
									id="recruiter-email"
									type="email"
									placeholder="recruiter@example.com"
									value={recruiterEmail}
									onChange={(e) => setRecruiterEmail(e.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="recruiter-message" className="text-xs">
									<Trans>Message (optional)</Trans>
								</Label>
								<Textarea
									id="recruiter-message"
									placeholder={t`Hey, would love your feedback...`}
									value={message}
									onChange={(e) => setMessage(e.target.value)}
									rows={2}
								/>
							</div>
							<div className="flex items-center gap-2">
								<input
									id="notify-recruiter"
									type="checkbox"
									className="size-3.5 rounded border-input"
									checked={notify}
									onChange={(e) => setNotify(e.target.checked)}
								/>
								<Label htmlFor="notify-recruiter" className="font-normal text-xs">
									<Trans>Email notification</Trans>
								</Label>
							</div>
							<Button onClick={() => void onPublish()} disabled={publish.isPending} className="w-full gap-2">
								{publish.isPending ? (
									<CircleNotchIcon className="size-4 animate-spin" />
								) : (
									<PaperPlaneTiltIcon className="size-4" />
								)}
								<Trans>Publish for Review</Trans>
							</Button>
						</div>
					)}

					{hasSession && activeSession && (
						<div className="space-y-2 rounded-md border p-3 text-xs">
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-2">
									<CheckCircleIcon className="size-4 shrink-0 text-emerald-500" />
									<span className="truncate">
										<Trans>
											Sharing with {activeSession.recruiterEmail ?? t`(no recruiter set)`}
										</Trans>
									</span>
								</div>
								<Button
									size="icon"
									variant="ghost"
									className="size-7 shrink-0"
									title={t`Open Google Doc in a new tab`}
									onClick={() => window.open(activeSession.docUrl, "_blank", "noopener,noreferrer")}
								>
									<ArrowSquareOutIcon className="size-3" />
								</Button>
							</div>
							<button
								type="button"
								className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
								onClick={() => setShowSharingForm((v) => !v)}
							>
								{showSharingForm ? <Trans>Hide sharing options</Trans> : <Trans>Change sharing…</Trans>}
							</button>
							{showSharingForm && (
								<div className="space-y-2 border-t pt-2">
									<div className="space-y-1">
										<Label htmlFor="recruiter-email" className="text-[11px]">
											<Trans>Add / change recruiter email</Trans>
										</Label>
										<Input
											id="recruiter-email"
											type="email"
											placeholder={activeSession.recruiterEmail ?? "recruiter@example.com"}
											value={recruiterEmail}
											onChange={(e) => setRecruiterEmail(e.target.value)}
										/>
									</div>
									<div className="space-y-1">
										<Label htmlFor="recruiter-message" className="text-[11px]">
											<Trans>Message (sent with share notification)</Trans>
										</Label>
										<Textarea
											id="recruiter-message"
											placeholder={t`Hey, would love your feedback...`}
											value={message}
											onChange={(e) => setMessage(e.target.value)}
											rows={2}
										/>
									</div>
									<div className="flex items-center gap-2">
										<input
											id="notify-recruiter"
											type="checkbox"
											className="size-3.5 rounded border-input"
											checked={notify}
											onChange={(e) => setNotify(e.target.checked)}
										/>
										<Label htmlFor="notify-recruiter" className="font-normal text-[11px]">
											<Trans>Send Google notification email</Trans>
										</Label>
									</div>
									<Button
										onClick={() => void onSaveSharingOnly()}
										disabled={updateSharing.isPending}
										variant="outline"
										className="w-full gap-2"
									>
										{updateSharing.isPending ? (
											<CircleNotchIcon className="size-4 animate-spin" />
										) : (
											<PaperPlaneTiltIcon className="size-4" />
										)}
										<Trans>Save sharing</Trans>
									</Button>
									<p className="text-[10px] text-muted-foreground">
										<Trans>
											Only changes who can comment on the doc. Does NOT re-render the doc body or replace the PDF —
											use "Push update to Doc" below for that.
										</Trans>
									</p>
								</div>
							)}
						</div>
					)}

					{hasSession && (
						<>
							<div className="space-y-2 rounded-md border p-3">
								<h3 className="font-medium text-sm">
									<Trans>2 · Fetch comments</Trans>
								</h3>
								<p className="text-muted-foreground text-xs">
									<Trans>Pull the recruiter's comments from the Google Doc.</Trans>
								</p>
								<Button
									variant="outline"
									onClick={() => void onFetch()}
									disabled={syncComments.isPending}
									className="w-full gap-2"
								>
									{syncComments.isPending ? (
										<CircleNotchIcon className="size-4 animate-spin" />
									) : (
										<DownloadSimpleIcon className="size-4" />
									)}
									<Trans>Fetch Comments</Trans>
								</Button>
							</div>

							<div className="space-y-3 rounded-md border p-3">
								<div className="flex items-center justify-between">
									<h3 className="font-medium text-sm">
										<Trans>3 · Pending comments ({openComments.length})</Trans>
									</h3>
								</div>
								{!hasOpenComments && !hasPendingProposals && !hasDecidedProposals && (
									<p className="text-muted-foreground text-xs">
										<Trans>No open comments. Press fetch after the recruiter leaves feedback.</Trans>
									</p>
								)}
								{hasOpenComments && !hasPendingProposals && (
									<ul className="max-h-80 space-y-2 overflow-y-auto">
										{openComments.map((c) => (
											<li key={c.id} className="rounded-md border p-2 text-xs">
												<div className="flex items-baseline justify-between gap-2">
													<span className="font-medium">{c.authorName ?? t`Recruiter`}</span>
													{c.jsonPath && (
														<code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
															{c.jsonPath}
														</code>
													)}
												</div>
												{c.anchoredText && (
													<p className="mt-1 line-clamp-2 italic text-muted-foreground">"{c.anchoredText}"</p>
												)}
												<p className="mt-1 whitespace-pre-wrap">{c.commentText}</p>
											</li>
										))}
									</ul>
								)}
								{!hasPendingProposals && (
									<Button
										onClick={() => void onPropose()}
										disabled={proposeChanges.isPending || !hasOpenComments}
										className="w-full gap-2"
									>
										{proposeChanges.isPending ? (
											<CircleNotchIcon className="size-4 animate-spin" />
										) : (
											<MagicWandIcon className="size-4" />
										)}
										<Trans>Propose changes with Codex</Trans>
									</Button>
								)}

								{(hasPendingProposals || (hasDecidedProposals && !hasOpenComments)) && (
									<div className="space-y-3">
										<div className="flex items-center justify-between">
											<p className="font-medium text-xs">
												<Trans>
													Proposed changes ({pendingProposals.length} pending / {decidedProposals.length} decided)
												</Trans>
											</p>
											<Button
												size="sm"
												variant="ghost"
												className="h-7 gap-1 text-[11px]"
												onClick={() => void onResetProposals()}
												disabled={resetProposals.isPending}
											>
												<ArrowCounterClockwiseIcon className="size-3" />
												<Trans>Reset all</Trans>
											</Button>
										</div>
										<ul className="max-h-[28rem] space-y-2 overflow-y-auto">
											{(proposals.data ?? []).map((p) => (
												<ProposalCard
													key={p.id}
													proposal={p}
													onApply={() => void onApplyProposal(p.id, p.title)}
													onDiscard={() => void onDiscardProposal(p.id, p.title)}
													disabled={applyProposal.isPending || discardProposal.isPending || resetProposals.isPending}
												/>
											))}
										</ul>
										{pendingProposals.length === 0 && (
											<p className="text-muted-foreground text-[10px]">
												<Trans>
													All proposals processed. Use "Push update to Doc" below to send the latest resume to the
													Google Doc.
												</Trans>
											</p>
										)}
									</div>
								)}
							</div>

							<HistorySection
								title={t`Applied`}
								emptyLabel={t`No comments applied yet.`}
								items={historyApplied.data ?? []}
								onDelete={onDeleteRecord}
								isDeleting={deleteRecord.isPending}
							/>
							<HistorySection
								title={t`Dismissed`}
								emptyLabel={t`No dismissed comments.`}
								items={historyDismissed.data ?? []}
								onDelete={onDeleteRecord}
								isDeleting={deleteRecord.isPending}
							/>

							{sessions.data && sessions.data.length > 0 && (
								<div className="space-y-2 border-t pt-3">
									<p className="font-medium text-[10px] uppercase tracking-wider text-muted-foreground">
										<Trans>Active reviews</Trans>
									</p>
									<ul className="space-y-1.5">
										{sessions.data.map((session) => (
											<li
												key={session.id}
												className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs"
											>
												<div className="min-w-0 flex-1 truncate">
													{session.recruiterEmail ?? t`No recruiter`} ·{" "}
													{new Date(session.createdAt).toLocaleDateString()}
												</div>
												<Button
													size="icon"
													variant="ghost"
													className="size-7"
													onClick={() => window.open(session.docUrl, "_blank", "noopener,noreferrer")}
												>
													<ArrowSquareOutIcon className="size-3" />
												</Button>
											</li>
										))}
									</ul>
								</div>
							)}

							<div className="sticky bottom-0 -mx-4 mt-2 border-t bg-background px-4 pt-3 pb-1">
								<Button
									onClick={() => void onQuickPushUpdate()}
									disabled={publish.isPending}
									className="w-full gap-2"
								>
									{publish.isPending ? (
										<CircleNotchIcon className="size-4 animate-spin" />
									) : (
										<UploadSimpleIcon className="size-4" />
									)}
									<Trans>Push update to Doc</Trans>
								</Button>
								{pendingProposals.length > 0 && (
									<p className="mt-1 text-[10px] text-amber-500/90">
										<Trans>
											{pendingProposals.length} pending proposal{pendingProposals.length === 1 ? "" : "s"} will
											not be pushed.
										</Trans>
									</p>
								)}
							</div>
						</>
					)}
				</div>
			)}
		</SectionBase>
	);
}

type HistoryItem = {
	id: string;
	jsonPath: string | null;
	anchoredText: string | null;
	commentText: string;
	authorName: string | null;
	status: "open" | "applied" | "dismissed";
	appliedAt: string | null;
	appliedNote: string | null;
	driveCreatedAt: string | null;
};

function HistorySection(props: {
	title: string;
	emptyLabel: string;
	items: HistoryItem[];
	onDelete?: (commentId: string) => void | Promise<void>;
	isDeleting?: boolean;
}) {
	const count = props.items.length;
	if (count === 0) return null;
	return (
		<details className="space-y-2 rounded-md border p-3 text-xs [&[open]>summary>svg]:rotate-90">
			<summary className="flex cursor-pointer items-center gap-2 font-medium text-sm marker:hidden">
				<span className="transition-transform">▸</span>
				<span className="flex-1">{props.title}</span>
				<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{count}</span>
			</summary>
			<ul className="mt-2 space-y-2">
				{props.items.map((c) => (
					<li key={c.id} className="rounded-md border p-2">
						<div className="flex items-baseline justify-between gap-2">
							<span className="font-medium">{c.authorName ?? "Recruiter"}</span>
							<div className="flex items-center gap-1">
								{c.jsonPath && (
									<code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{c.jsonPath}</code>
								)}
								{props.onDelete && (
									<Button
										size="icon"
										variant="ghost"
										className="size-6"
										title="Remove from local history"
										disabled={props.isDeleting}
										onClick={() => void props.onDelete?.(c.id)}
									>
										<TrashIcon className="size-3" />
									</Button>
								)}
							</div>
						</div>
						{c.anchoredText && (
							<p className="mt-1 line-clamp-2 italic text-muted-foreground">"{c.anchoredText}"</p>
						)}
						<p className="mt-1 whitespace-pre-wrap">{c.commentText}</p>
						{c.appliedNote && (
							<details className="mt-2 rounded bg-muted/40 p-2 text-[11px]">
								<summary className="cursor-pointer text-muted-foreground">
									{c.status === "applied" ? "Applied note" : "Dismissed note"}
									{c.appliedAt ? ` · ${new Date(c.appliedAt).toLocaleString()}` : ""}
								</summary>
								<p className="mt-1 whitespace-pre-wrap">{c.appliedNote}</p>
							</details>
						)}
					</li>
				))}
			</ul>
		</details>
	);
}

type Proposal = {
	id: string;
	title: string;
	jsonPath: string;
	beforeValue: unknown;
	afterValue: unknown;
	reasoning: string | null;
	commentIds: string[];
	status: "pending" | "applied" | "discarded";
	decidedAt: string | null;
	createdAt: string;
};

function formatProposalValue(value: unknown): string {
	if (value === undefined || value === null) return "(empty)";
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length === 0 ? "(empty)" : trimmed;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return "(empty array)";
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
	if (typeof value === "object") {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function ProposalCard(props: {
	proposal: Proposal;
	onApply: () => void;
	onDiscard: () => void;
	disabled?: boolean;
}) {
	const p = props.proposal;
	const isPending = p.status === "pending";
	const before = formatProposalValue(p.beforeValue);
	const after = formatProposalValue(p.afterValue);

	const activeIds = useProposalPreviewStore((s) => s.activeIds);
	const togglePreviewStore = useProposalPreviewStore((s) => s.toggle);
	const removeActive = useProposalPreviewStore((s) => s.remove);
	const setFieldPreview = useResumeStore((s) => s.setFieldPreview);
	const isPreviewingAfter = activeIds.has(p.id);

	const handleTogglePreview = () => {
		if (isPreviewingAfter) {
			setFieldPreview(p.jsonPath, p.beforeValue);
		} else {
			setFieldPreview(p.jsonPath, p.afterValue);
		}
		togglePreviewStore(p.id);
	};

	const handleApply = () => {
		removeActive(p.id);
		props.onApply();
	};

	const handleDiscard = () => {
		if (isPreviewingAfter) {
			setFieldPreview(p.jsonPath, p.beforeValue);
			removeActive(p.id);
		}
		props.onDiscard();
	};

	return (
		<li
			className={
				"space-y-2 rounded-md border p-2 text-xs " +
				(p.status === "applied"
					? "border-emerald-500/30 bg-emerald-500/5"
					: p.status === "discarded"
						? "border-muted-foreground/30 bg-muted/30 opacity-70"
						: isPreviewingAfter
							? "border-sky-500/40 bg-sky-500/5"
							: "")
			}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<p className="font-medium">{p.title}</p>
					<code className="mt-0.5 inline-block rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
						{p.jsonPath}
					</code>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{isPending && (
						<Button
							size="icon"
							variant={isPreviewingAfter ? "default" : "ghost"}
							className="size-6"
							title={isPreviewingAfter ? "Showing 'after' in preview — click to revert" : "Preview this change in the resume"}
							onClick={handleTogglePreview}
							disabled={props.disabled}
						>
							{isPreviewingAfter ? <EyeIcon className="size-3" /> : <EyeSlashIcon className="size-3" />}
						</Button>
					)}
					{!isPending && (
						<span
							className={
								"rounded-full px-2 py-0.5 text-[10px] font-medium " +
								(p.status === "applied" ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")
							}
						>
							{p.status === "applied" ? "✓ Applied" : "✖ Discarded"}
						</span>
					)}
				</div>
			</div>

			{p.reasoning && <p className="text-[11px] italic text-muted-foreground">{p.reasoning}</p>}

			<div className="space-y-1">
				<div
					className={
						"rounded border p-1.5 " +
						(isPreviewingAfter
							? "border-rose-500/20 bg-rose-500/5 opacity-60"
							: "border-rose-500/30 bg-rose-500/10")
					}
				>
					<p className="text-[10px] font-semibold uppercase tracking-wider text-rose-600/80">
						Before {isPreviewingAfter ? "" : "(showing in preview)"}
					</p>
					<pre className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px]">{before}</pre>
				</div>
				<div
					className={
						"rounded border p-1.5 " +
						(isPreviewingAfter
							? "border-emerald-500/40 bg-emerald-500/10"
							: "border-emerald-500/20 bg-emerald-500/5 opacity-60")
					}
				>
					<p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600/80">
						After {isPreviewingAfter ? "(showing in preview)" : ""}
					</p>
					<pre className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px]">{after}</pre>
				</div>
			</div>

			{isPending && (
				<div className="flex gap-2">
					<Button size="sm" className="h-7 flex-1 gap-1 text-[11px]" onClick={handleApply} disabled={props.disabled}>
						<CheckIcon className="size-3" />
						<Trans>Apply</Trans>
					</Button>
					<Button
						size="sm"
						variant="outline"
						className="h-7 flex-1 gap-1 text-[11px]"
						onClick={handleDiscard}
						disabled={props.disabled}
					>
						<XIcon className="size-3" />
						<Trans>Discard</Trans>
					</Button>
				</div>
			)}
		</li>
	);
}
