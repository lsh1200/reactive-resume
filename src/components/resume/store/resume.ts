import { t } from "@lingui/core/macro";
import { debounce } from "es-toolkit";
import { set as setPath } from "es-toolkit/compat";
import isDeepEqual from "fast-deep-equal";
import type { WritableDraft } from "immer";
import { current } from "immer";
import { toast } from "sonner";
import type { TemporalState } from "zundo";
import { temporal } from "zundo";
import { immer } from "zustand/middleware/immer";
import { create } from "zustand/react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { orpc, type RouterOutput } from "@/integrations/orpc/client";
import type { ResumeData } from "@/schema/resume/data";

type Resume = Pick<RouterOutput["resume"]["getByIdForPrinter"], "id" | "name" | "slug" | "tags" | "data" | "isLocked">;

type ResumeStoreState = {
	resume: Resume;
	isReady: boolean;
};

type ResumeStoreActions = {
	initialize: (resume: Resume | null) => void;
	updateResumeData: (fn: (draft: WritableDraft<ResumeData>) => void) => void;
	setFieldPreview: (jsonPath: string, value: unknown) => void;
};

type ResumeStore = ResumeStoreState & ResumeStoreActions;

const controller = new AbortController();
const signal = controller.signal;

const _syncResume = (resume: Resume) => {
	orpc.resume.update.call({ id: resume.id, data: resume.data }, { signal });
};

const syncResume = debounce(_syncResume, 500, { signal });

let errorToastId: string | number | undefined;

type PartializedState = { resume: Resume | null };

export const useResumeStore = create<ResumeStore>()(
	temporal(
		immer((set) => ({
			resume: null as unknown as Resume,
			isReady: false,

			initialize: (resume) => {
				set((state) => {
					state.resume = resume as Resume;
					state.isReady = resume !== null;
					useResumeStore.temporal.getState().clear();
				});
			},

			updateResumeData: (fn) => {
				set((state) => {
					if (!state.resume) return state;

					if (state.resume.isLocked) {
						errorToastId = toast.error(t`This resume is locked and cannot be updated.`, { id: errorToastId });
						return state;
					}

					fn(state.resume.data);
					syncResume(current(state.resume));
				});
			},

			// Visual-only mutation: changes the in-memory resume.data without persisting to the DB.
			// Used by the Codex proposal preview toggles so the user can compare before/after.
			setFieldPreview: (jsonPath, value) => {
				set((state) => {
					if (!state.resume) return state;
					setPath(state.resume.data as unknown as object, jsonPath, value);
				});
			},
		})),
		{
			partialize: (state) => ({ resume: state.resume }),
			equality: (pastState, currentState) => isDeepEqual(pastState, currentState),
			limit: 100,
		},
	),
);

export function useTemporalStore<T>(selector: (state: TemporalState<PartializedState>) => T): T {
	return useStoreWithEqualityFn(useResumeStore.temporal, selector);
}
