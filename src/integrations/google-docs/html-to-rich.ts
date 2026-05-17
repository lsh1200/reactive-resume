export type RichRun = {
	start: number;
	end: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	link?: string;
};

export type RichParagraph = {
	start: number;
	end: number;
	kind: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "li";
	listType?: "ul" | "ol";
	listLevel?: number;
};

export type RichText = {
	text: string;
	paragraphs: RichParagraph[];
	runs: RichRun[];
};

type Token =
	| { kind: "open"; tag: string }
	| { kind: "close"; tag: string }
	| { kind: "void"; tag: string }
	| { kind: "text"; value: string }
	| { kind: "attr-open"; tag: string; attrs: string };

function decodeEntities(input: string): string {
	return input
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function parseHref(attrs: string): string | undefined {
	const match = attrs.match(/href\s*=\s*"([^"]+)"/i) ?? attrs.match(/href\s*=\s*'([^']+)'/i);
	return match?.[1];
}

function tokenize(html: string): Token[] {
	const tokens: Token[] = [];
	const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)(\/)?>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tagRegex.exec(html)) !== null) {
		if (match.index > lastIndex) {
			tokens.push({ kind: "text", value: html.slice(lastIndex, match.index) });
		}
		const tag = match[1].toLowerCase();
		const attrs = match[2] ?? "";
		const isClose = match[0].startsWith("</");
		const isSelfClose = Boolean(match[3]) || tag === "br" || tag === "hr" || tag === "img";
		if (isClose) {
			tokens.push({ kind: "close", tag });
		} else if (isSelfClose) {
			tokens.push({ kind: "void", tag });
		} else if (attrs.trim().length > 0) {
			tokens.push({ kind: "attr-open", tag, attrs });
		} else {
			tokens.push({ kind: "open", tag });
		}
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < html.length) {
		tokens.push({ kind: "text", value: html.slice(lastIndex) });
	}
	return tokens;
}

const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li"]);
const LIST_TAGS = new Set(["ul", "ol"]);
const INLINE_STYLE_TAGS = new Set(["strong", "b", "em", "i", "u"]);

type ParagraphState = {
	startInText: number;
	kind: RichParagraph["kind"];
	listType?: "ul" | "ol";
	listLevel?: number;
};

type StyleState = {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	link?: string;
};

type RunState = {
	startInText: number;
	state: StyleState;
};

export function parseHtmlToRich(html: string | null | undefined): RichText {
	if (!html || html.trim().length === 0) {
		return { text: "", paragraphs: [], runs: [] };
	}

	const tokens = tokenize(html);
	const out: string[] = [];
	let cursor = 0;

	const paragraphs: RichParagraph[] = [];
	const runs: RichRun[] = [];

	const paragraphStack: ParagraphState[] = [];
	const listStack: { type: "ul" | "ol"; level: number }[] = [];

	const styleStack: StyleState[] = [];
	let currentRun: RunState | null = null;

	const append = (s: string) => {
		if (s.length === 0) return;
		out.push(s);
		cursor += s.length;
	};

	const lastChar = () => {
		for (let i = out.length - 1; i >= 0; i--) {
			if (out[i].length === 0) continue;
			return out[i].charAt(out[i].length - 1);
		}
		return "";
	};

	const closeRun = () => {
		if (!currentRun) return;
		if (cursor > currentRun.startInText) {
			const { bold, italic, underline, link } = currentRun.state;
			if (bold || italic || underline || link) {
				runs.push({
					start: currentRun.startInText,
					end: cursor,
					bold,
					italic,
					underline,
					link,
				});
			}
		}
		currentRun = null;
	};

	const openRunIfNeeded = () => {
		if (currentRun) return;
		const merged: StyleState = {};
		for (const s of styleStack) {
			if (s.bold) merged.bold = true;
			if (s.italic) merged.italic = true;
			if (s.underline) merged.underline = true;
			if (s.link) merged.link = s.link;
		}
		currentRun = { startInText: cursor, state: merged };
	};

	const openParagraph = (kind: RichParagraph["kind"]) => {
		if (paragraphStack.length > 0) closeParagraph();
		if (lastChar() !== "\n" && cursor > 0) append("\n");
		closeRun();
		const list = listStack[listStack.length - 1];
		paragraphStack.push({
			startInText: cursor,
			kind,
			listType: kind === "li" ? list?.type : undefined,
			listLevel: kind === "li" ? list?.level : undefined,
		});
		openRunIfNeeded();
	};

	const closeParagraph = () => {
		const p = paragraphStack.pop();
		if (!p) return;
		closeRun();
		const end = cursor;
		if (end > p.startInText) {
			paragraphs.push({
				start: p.startInText,
				end,
				kind: p.kind,
				listType: p.listType,
				listLevel: p.listLevel,
			});
		}
		append("\n");
		openRunIfNeeded();
	};

	for (const token of tokens) {
		if (token.kind === "text") {
			const normalized = token.value.replace(/\s+/g, " ");
			if (normalized.length === 0) continue;
			if (paragraphStack.length === 0) openParagraph("p");
			openRunIfNeeded();
			append(decodeEntities(normalized));
			continue;
		}

		const tag = "tag" in token ? token.tag : "";

		if (token.kind === "void") {
			if (tag === "br") {
				closeRun();
				append("\n");
				openRunIfNeeded();
			}
			continue;
		}

		if (token.kind === "open" || token.kind === "attr-open") {
			if (LIST_TAGS.has(tag)) {
				listStack.push({ type: tag as "ul" | "ol", level: listStack.length });
				continue;
			}
			if (PARAGRAPH_TAGS.has(tag)) {
				openParagraph(tag as RichParagraph["kind"]);
				continue;
			}
			if (INLINE_STYLE_TAGS.has(tag)) {
				closeRun();
				const state: StyleState = {};
				if (tag === "strong" || tag === "b") state.bold = true;
				if (tag === "em" || tag === "i") state.italic = true;
				if (tag === "u") state.underline = true;
				styleStack.push(state);
				openRunIfNeeded();
				continue;
			}
			if (tag === "a") {
				closeRun();
				const href = token.kind === "attr-open" ? parseHref(token.attrs) : undefined;
				styleStack.push({ link: href, underline: true });
				openRunIfNeeded();
				continue;
			}
			continue;
		}

		if (token.kind === "close") {
			if (LIST_TAGS.has(tag)) {
				listStack.pop();
				continue;
			}
			if (PARAGRAPH_TAGS.has(tag)) {
				closeParagraph();
				continue;
			}
			if (INLINE_STYLE_TAGS.has(tag) || tag === "a") {
				closeRun();
				styleStack.pop();
				openRunIfNeeded();
				continue;
			}
			continue;
		}
	}

	closeParagraph();

	while (out.length > 0 && out[out.length - 1] === "\n") out.pop();
	const text = out.join("");
	const trimEnd = text.length;
	for (let i = paragraphs.length - 1; i >= 0; i--) {
		if (paragraphs[i].end > trimEnd) paragraphs[i].end = trimEnd;
	}

	return { text, paragraphs, runs };
}
