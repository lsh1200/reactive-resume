import { create } from "zustand/react";

type PreviewStore = {
	activeIds: Set<string>;
	isActive: (proposalId: string) => boolean;
	toggle: (proposalId: string) => void;
	remove: (proposalId: string) => void;
	clear: () => void;
};

export const useProposalPreviewStore = create<PreviewStore>((set, get) => ({
	activeIds: new Set<string>(),
	isActive: (proposalId) => get().activeIds.has(proposalId),
	toggle: (proposalId) =>
		set((state) => {
			const next = new Set(state.activeIds);
			if (next.has(proposalId)) next.delete(proposalId);
			else next.add(proposalId);
			return { activeIds: next };
		}),
	remove: (proposalId) =>
		set((state) => {
			if (!state.activeIds.has(proposalId)) return state;
			const next = new Set(state.activeIds);
			next.delete(proposalId);
			return { activeIds: next };
		}),
	clear: () => set({ activeIds: new Set() }),
}));
