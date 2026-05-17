const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "tr"]);
const LIST_TAGS = new Set(["ul", "ol"]);

type Token =
	| { kind: "open"; tag: string }
	| { kind: "close"; tag: string }
	| { kind: "void"; tag: string }
	| { kind: "text"; value: string };

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

function tokenize(html: string): Token[] {
	const tokens: Token[] = [];
	const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?(\/)?>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tagRegex.exec(html)) !== null) {
		if (match.index > lastIndex) {
			tokens.push({ kind: "text", value: html.slice(lastIndex, match.index) });
		}
		const tag = match[1].toLowerCase();
		const isClose = match[0].startsWith("</");
		const isSelfClose = Boolean(match[2]) || tag === "br" || tag === "hr" || tag === "img";
		if (isClose) {
			tokens.push({ kind: "close", tag });
		} else if (isSelfClose) {
			tokens.push({ kind: "void", tag });
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

export function htmlToPlainText(html: string | null | undefined): string {
	if (!html) return "";

	const tokens = tokenize(html);
	const out: string[] = [];
	const listStack: { type: "ul" | "ol"; index: number }[] = [];

	const lastChar = () => {
		for (let i = out.length - 1; i >= 0; i--) {
			if (out[i].length === 0) continue;
			return out[i].charAt(out[i].length - 1);
		}
		return "";
	};
	const appendNewline = () => {
		if (lastChar() !== "\n" && out.length > 0) out.push("\n");
	};
	const appendDoubleNewline = () => {
		const c = lastChar();
		if (out.length === 0) return;
		if (c === "\n") out.push("\n");
		else out.push("\n\n");
	};

	for (const token of tokens) {
		if (token.kind === "text") {
			const trimmed = token.value.replace(/\s+/g, " ");
			if (trimmed.trim().length === 0 && lastChar() === "\n") continue;
			out.push(decodeEntities(trimmed));
			continue;
		}

		const tag = token.tag;

		if (token.kind === "void" && tag === "br") {
			appendNewline();
			continue;
		}
		if (token.kind === "open" && LIST_TAGS.has(tag)) {
			appendNewline();
			listStack.push({ type: tag as "ul" | "ol", index: 0 });
			continue;
		}
		if (token.kind === "close" && LIST_TAGS.has(tag)) {
			listStack.pop();
			appendNewline();
			continue;
		}
		if (token.kind === "open" && tag === "li") {
			appendNewline();
			const current = listStack[listStack.length - 1];
			if (current?.type === "ol") {
				current.index += 1;
				out.push(`${current.index}. `);
			} else {
				out.push("• ");
			}
			continue;
		}
		if (token.kind === "close" && tag === "li") {
			appendNewline();
			continue;
		}
		if (token.kind === "open" && BLOCK_TAGS.has(tag)) {
			appendNewline();
			continue;
		}
		if (token.kind === "close" && BLOCK_TAGS.has(tag)) {
			appendDoubleNewline();
			continue;
		}
	}

	return out
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
