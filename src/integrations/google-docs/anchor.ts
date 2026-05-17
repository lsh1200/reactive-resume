import type { FieldMapEntry } from "./renderer";

export type ParsedAnchor = {
	startIndex: number;
	endIndex: number;
	revisionId?: string;
};

type AnchorJson = {
	r?: string;
	a?: { txt?: { o?: number; l?: number; hi?: string } }[];
};

export function parseDriveAnchor(anchor: string | undefined | null): ParsedAnchor | null {
	if (!anchor) return null;
	const trimmed = anchor.trim();
	if (trimmed.length === 0) return null;

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as AnchorJson;
			const range = parsed.a?.find((entry) => entry.txt && typeof entry.txt.o === "number");
			if (range?.txt && typeof range.txt.o === "number" && typeof range.txt.l === "number") {
				const start = range.txt.o;
				return { startIndex: start, endIndex: start + range.txt.l, revisionId: parsed.r };
			}
		} catch {
			// fall through
		}
	}

	const kixMatch = trimmed.match(/kix\.[\w-]+/);
	if (kixMatch) {
		const numbers = trimmed.match(/(\d+)/g);
		if (numbers && numbers.length >= 2) {
			const start = Number(numbers[numbers.length - 2]);
			const end = Number(numbers[numbers.length - 1]);
			if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
				return { startIndex: start, endIndex: end };
			}
		}
	}

	return null;
}

export type FieldMatch = {
	jsonPath: string;
	kind: "text" | "html";
	overlapChars: number;
	entry: FieldMapEntry;
};

export function findBestFieldMatch(
	entries: FieldMapEntry[],
	range: ParsedAnchor,
): FieldMatch | null {
	let best: FieldMatch | null = null;
	for (const entry of entries) {
		const overlapStart = Math.max(entry.startIndex, range.startIndex);
		const overlapEnd = Math.min(entry.endIndex, range.endIndex);
		const overlap = overlapEnd - overlapStart;
		if (overlap <= 0) continue;
		if (!best || overlap > best.overlapChars) {
			best = { jsonPath: entry.jsonPath, kind: entry.kind, overlapChars: overlap, entry };
		}
	}
	return best;
}
