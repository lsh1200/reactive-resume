import type {
	ResumeData,
	SectionData,
	SectionType,
} from "@/schema/resume/data";
import type { DocsRequest } from "./api";
import { parseHtmlToRich } from "./html-to-rich";

export type FieldMapEntry = {
	startIndex: number;
	endIndex: number;
	jsonPath: string;
	kind: "text" | "html";
	label?: string;
};

export type RenderResult = {
	requests: DocsRequest[];
	fieldMap: FieldMapEntry[];
	plainText: string;
};

type RgbColor = { red: number; green: number; blue: number };

type Builder = {
	cursor: number;
	insertions: DocsRequest[];
	style: DocsRequest[];
	bulletOps: DocsRequest[];
	fieldMap: FieldMapEntry[];
	chunks: string[];
	primary: RgbColor;
	fontBody: string;
	fontHeading: string;
};

function parseRgba(input: string | undefined): RgbColor {
	const fallback: RgbColor = { red: 0.86, green: 0.15, blue: 0.15 };
	if (!input) return fallback;
	const match = input.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (!match) return fallback;
	const clamp = (v: number) => Math.min(1, Math.max(0, v / 255));
	return { red: clamp(Number(match[1])), green: clamp(Number(match[2])), blue: clamp(Number(match[3])) };
}

function createBuilder(resume: ResumeData): Builder {
	return {
		cursor: 1,
		insertions: [],
		style: [],
		bulletOps: [],
		fieldMap: [],
		chunks: [],
		primary: parseRgba(resume.metadata.design.colors.primary),
		fontBody: resume.metadata.typography.body.fontFamily || "Roboto",
		fontHeading: resume.metadata.typography.heading.fontFamily || "Roboto",
	};
}

function insertRaw(builder: Builder, text: string): { start: number; end: number } {
	if (text.length === 0) return { start: builder.cursor, end: builder.cursor };
	const start = builder.cursor;
	builder.insertions.push({ insertText: { location: { index: start }, text } });
	builder.chunks.push(text);
	builder.cursor += text.length;
	return { start, end: builder.cursor };
}

function applyParagraphStyle(
	builder: Builder,
	start: number,
	end: number,
	paragraphStyle: Record<string, unknown>,
	fields: string,
): void {
	if (end <= start) return;
	builder.style.push({
		updateParagraphStyle: { range: { startIndex: start, endIndex: end }, paragraphStyle, fields },
	});
}

function applyTextStyle(builder: Builder, start: number, end: number, style: Record<string, unknown>): void {
	if (end <= start) return;
	const fields = Object.keys(style).join(",");
	builder.style.push({
		updateTextStyle: { range: { startIndex: start, endIndex: end }, textStyle: style, fields },
	});
}

function applyFontTo(builder: Builder, start: number, end: number, family: string): void {
	applyTextStyle(builder, start, end, {
		weightedFontFamily: { fontFamily: family, weight: 400 },
	});
}

function applyBulletList(builder: Builder, start: number, end: number, ordered: boolean): void {
	if (end <= start) return;
	builder.bulletOps.push({
		createParagraphBullets: {
			range: { startIndex: start, endIndex: end },
			bulletPreset: ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
		},
	});
}

function trackField(
	builder: Builder,
	start: number,
	end: number,
	jsonPath: string,
	kind: "text" | "html" = "text",
	label?: string,
): void {
	if (end <= start) return;
	builder.fieldMap.push({ startIndex: start, endIndex: end, jsonPath, kind, label });
}

function emitPlainLine(
	builder: Builder,
	value: string,
	jsonPath: string,
	options: { bold?: boolean; italic?: boolean; font?: string } = {},
): void {
	if (!value) return;
	const { start, end } = insertRaw(builder, value);
	trackField(builder, start, end, jsonPath);
	const ts: Record<string, unknown> = {};
	if (options.bold) ts.bold = true;
	if (options.italic) ts.italic = true;
	if (Object.keys(ts).length > 0) applyTextStyle(builder, start, end, ts);
	if (options.font) applyFontTo(builder, start, end, options.font);
	insertRaw(builder, "\n");
}

function emitSectionHeading(builder: Builder, title: string, jsonPath: string): void {
	const display = title.trim().length > 0 ? title : defaultSectionTitle(jsonPath);
	if (!display) return;

	const { start, end } = insertRaw(builder, display);
	trackField(builder, start, end, jsonPath);
	insertRaw(builder, "\n");
	const paragraphEnd = end + 1;

	applyParagraphStyle(
		builder,
		start,
		paragraphEnd,
		{
			namedStyleType: "HEADING_1",
			borderBottom: {
				color: { color: { rgbColor: builder.primary } },
				width: { magnitude: 1.5, unit: "PT" },
				padding: { magnitude: 2, unit: "PT" },
				dashStyle: "SOLID",
			},
			spaceAbove: { magnitude: 12, unit: "PT" },
			spaceBelow: { magnitude: 6, unit: "PT" },
		},
		"namedStyleType,borderBottom,spaceAbove,spaceBelow",
	);
	applyTextStyle(builder, start, end, {
		foregroundColor: { color: { rgbColor: builder.primary } },
		bold: true,
	});
	applyFontTo(builder, start, end, builder.fontHeading);
}

function defaultSectionTitle(jsonPath: string): string {
	const match = jsonPath.match(/sections\.([a-z]+)\.title/);
	if (!match) return "";
	const map: Record<string, string> = {
		profiles: "Profiles",
		experience: "Work Experience",
		education: "Education",
		projects: "Projects",
		skills: "Skills",
		languages: "Languages",
		interests: "Interests",
		awards: "Awards",
		certifications: "Certifications",
		publications: "Publications",
		volunteer: "Volunteer",
		references: "References",
	};
	return map[match[1]] ?? match[1].charAt(0).toUpperCase() + match[1].slice(1);
}

function emitInlineRow(
	builder: Builder,
	parts: { value: string; jsonPath: string; bold?: boolean; italic?: boolean }[],
	separator = "  ·  ",
): void {
	const visible = parts.filter((p) => (p.value ?? "").trim().length > 0);
	if (visible.length === 0) return;

	for (let i = 0; i < visible.length; i++) {
		const part = visible[i];
		const { start, end } = insertRaw(builder, part.value.trim());
		trackField(builder, start, end, part.jsonPath);
		const ts: Record<string, unknown> = {};
		if (part.bold) ts.bold = true;
		if (part.italic) ts.italic = true;
		if (Object.keys(ts).length > 0) applyTextStyle(builder, start, end, ts);
		if (i < visible.length - 1) insertRaw(builder, separator);
	}
	insertRaw(builder, "\n");
}

function emitContactLine(builder: Builder, basics: ResumeData["basics"]): void {
	const parts: { value: string; jsonPath: string }[] = [];
	if (basics.email) parts.push({ value: basics.email, jsonPath: "basics.email" });
	if (basics.phone) parts.push({ value: basics.phone, jsonPath: "basics.phone" });
	if (basics.location) parts.push({ value: basics.location, jsonPath: "basics.location" });
	const websiteLabel = basics.website?.label || basics.website?.url || "";
	if (websiteLabel) parts.push({ value: websiteLabel, jsonPath: "basics.website" });
	if (parts.length === 0) return;

	for (let i = 0; i < parts.length; i++) {
		if (i > 0) insertRaw(builder, "  •  ");
		const { start, end } = insertRaw(builder, parts[i].value);
		trackField(builder, start, end, parts[i].jsonPath);
	}
	insertRaw(builder, "\n");

	for (const cf of basics.customFields) {
		if (!cf.text) continue;
		const { start, end } = insertRaw(builder, cf.text);
		trackField(builder, start, end, `basics.customFields[${basics.customFields.indexOf(cf)}].text`);
		insertRaw(builder, "\n");
	}
}

function emitRich(
	builder: Builder,
	html: string,
	basePath: string,
	options: { fieldLabel?: string } = {},
): void {
	const rich = parseHtmlToRich(html);
	if (rich.text.length === 0) return;

	const offset = builder.cursor;
	insertRaw(builder, rich.text);
	if (!builder.chunks[builder.chunks.length - 1]?.endsWith("\n")) insertRaw(builder, "\n");

	trackField(builder, offset, offset + rich.text.length, basePath, "html", options.fieldLabel);

	for (const run of rich.runs) {
		const ts: Record<string, unknown> = {};
		if (run.bold) ts.bold = true;
		if (run.italic) ts.italic = true;
		if (run.underline) ts.underline = true;
		if (run.link) ts.link = { url: run.link };
		if (Object.keys(ts).length === 0) continue;
		applyTextStyle(builder, offset + run.start, offset + run.end, ts);
	}

	const bulletGroups: { start: number; end: number; ordered: boolean }[] = [];
	let current: { start: number; end: number; ordered: boolean } | null = null;
	for (const p of rich.paragraphs) {
		if (p.kind !== "li") {
			if (current) {
				bulletGroups.push(current);
				current = null;
			}
			continue;
		}
		const start = offset + p.start;
		const end = offset + p.end + 1;
		const ordered = p.listType === "ol";
		if (current && current.ordered === ordered && current.end >= start) {
			current.end = end;
		} else {
			if (current) bulletGroups.push(current);
			current = { start, end, ordered };
		}
	}
	if (current) bulletGroups.push(current);
	for (const group of bulletGroups) {
		applyBulletList(builder, group.start, group.end, group.ordered);
	}
}

function renderBasics(builder: Builder, basics: ResumeData["basics"]): void {
	if (basics.name) {
		const { start, end } = insertRaw(builder, basics.name);
		trackField(builder, start, end, "basics.name");
		insertRaw(builder, "\n");
		applyParagraphStyle(
			builder,
			start,
			end + 1,
			{
				namedStyleType: "TITLE",
				alignment: "START",
				spaceBelow: { magnitude: 0, unit: "PT" },
			},
			"namedStyleType,alignment,spaceBelow",
		);
		applyTextStyle(builder, start, end, {
			foregroundColor: { color: { rgbColor: builder.primary } },
			bold: true,
		});
		applyFontTo(builder, start, end, builder.fontHeading);
	}

	if (basics.headline) {
		const { start, end } = insertRaw(builder, basics.headline);
		trackField(builder, start, end, "basics.headline");
		insertRaw(builder, "\n");
		applyParagraphStyle(
			builder,
			start,
			end + 1,
			{
				namedStyleType: "SUBTITLE",
				spaceAbove: { magnitude: 0, unit: "PT" },
				spaceBelow: { magnitude: 6, unit: "PT" },
			},
			"namedStyleType,spaceAbove,spaceBelow",
		);
		applyTextStyle(builder, start, end, { italic: true });
		applyFontTo(builder, start, end, builder.fontHeading);
	}

	emitContactLine(builder, basics);
	insertRaw(builder, "\n");
}

function renderSummary(builder: Builder, summary: ResumeData["summary"]): void {
	if (summary.hidden || !summary.content) return;
	const title = summary.title?.trim() || "Summary";
	emitSectionHeading(builder, title, "summary.title");
	emitRich(builder, summary.content, "summary.content");
	insertRaw(builder, "\n");
}

type ItemRenderer<T extends SectionType> = (
	builder: Builder,
	item: SectionData<T>["items"][number],
	index: number,
	sectionKey: T,
) => void;

const itemRenderers: { [K in SectionType]: ItemRenderer<K> } = {
	profiles: (b, item, i) => {
		const label = item.website?.label || item.website?.url || item.username;
		emitInlineRow(b, [
			{ value: item.network, jsonPath: `sections.profiles.items[${i}].network`, bold: true },
			{ value: label, jsonPath: `sections.profiles.items[${i}].website` },
		]);
	},
	experience: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.company, jsonPath: `sections.experience.items[${i}].company`, bold: true },
			{ value: item.location, jsonPath: `sections.experience.items[${i}].location` },
		]);
		emitInlineRow(b, [
			{ value: item.position, jsonPath: `sections.experience.items[${i}].position`, italic: true },
			{ value: item.period, jsonPath: `sections.experience.items[${i}].period`, italic: true },
		]);
		emitRich(b, item.description, `sections.experience.items[${i}].description`);
		for (const [r, role] of (item.roles ?? []).entries()) {
			emitInlineRow(b, [
				{ value: role.position, jsonPath: `sections.experience.items[${i}].roles[${r}].position`, bold: true },
				{ value: role.period, jsonPath: `sections.experience.items[${i}].roles[${r}].period`, italic: true },
			]);
			emitRich(b, role.description, `sections.experience.items[${i}].roles[${r}].description`);
		}
		insertRaw(b, "\n");
	},
	education: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.school, jsonPath: `sections.education.items[${i}].school`, bold: true },
			{ value: item.location, jsonPath: `sections.education.items[${i}].location` },
		]);
		const degreeArea = [item.degree, item.area].filter(Boolean).join(", ");
		emitInlineRow(b, [
			{ value: degreeArea, jsonPath: `sections.education.items[${i}].degree`, italic: true },
			{ value: item.period, jsonPath: `sections.education.items[${i}].period`, italic: true },
		]);
		if (item.grade) {
			emitPlainLine(b, `Grade: ${item.grade}`, `sections.education.items[${i}].grade`);
		}
		emitRich(b, item.description, `sections.education.items[${i}].description`);
		insertRaw(b, "\n");
	},
	projects: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.name, jsonPath: `sections.projects.items[${i}].name`, bold: true },
			{ value: item.period, jsonPath: `sections.projects.items[${i}].period`, italic: true },
		]);
		emitRich(b, item.description, `sections.projects.items[${i}].description`);
		if (item.website?.url) {
			const label = item.website.label?.trim() || item.website.url;
			const { start, end } = insertRaw(b, label);
			trackField(b, start, end, `sections.projects.items[${i}].website`);
			applyTextStyle(b, start, end, {
				link: { url: item.website.url },
				underline: true,
				foregroundColor: { color: { rgbColor: b.primary } },
			});
			insertRaw(b, "\n");
		}
		insertRaw(b, "\n");
	},
	skills: (b, item, i) => {
		const proficiency = item.proficiency ? ` (${item.proficiency})` : "";
		emitPlainLine(b, `${item.name}${proficiency}`, `sections.skills.items[${i}].name`, { bold: true });
		if (item.keywords?.length) {
			emitPlainLine(b, item.keywords.join(", "), `sections.skills.items[${i}].keywords`, { italic: true });
		}
	},
	languages: (b, item, i) => {
		const fluency = item.fluency ? ` — ${item.fluency}` : "";
		emitPlainLine(b, `${item.language}${fluency}`, `sections.languages.items[${i}].language`);
	},
	interests: (b, item, i) => {
		const keywords = item.keywords?.length ? ` — ${item.keywords.join(", ")}` : "";
		emitPlainLine(b, `${item.name}${keywords}`, `sections.interests.items[${i}].name`);
	},
	awards: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.title, jsonPath: `sections.awards.items[${i}].title`, bold: true },
			{ value: item.date, jsonPath: `sections.awards.items[${i}].date`, italic: true },
		]);
		emitPlainLine(b, item.awarder, `sections.awards.items[${i}].awarder`, { italic: true });
		emitRich(b, item.description, `sections.awards.items[${i}].description`);
		insertRaw(b, "\n");
	},
	certifications: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.title, jsonPath: `sections.certifications.items[${i}].title`, bold: true },
			{ value: item.date, jsonPath: `sections.certifications.items[${i}].date`, italic: true },
		]);
		emitPlainLine(b, item.issuer, `sections.certifications.items[${i}].issuer`, { italic: true });
		emitRich(b, item.description, `sections.certifications.items[${i}].description`);
		insertRaw(b, "\n");
	},
	publications: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.title, jsonPath: `sections.publications.items[${i}].title`, bold: true },
			{ value: item.date, jsonPath: `sections.publications.items[${i}].date`, italic: true },
		]);
		emitPlainLine(b, item.publisher, `sections.publications.items[${i}].publisher`, { italic: true });
		emitRich(b, item.description, `sections.publications.items[${i}].description`);
		insertRaw(b, "\n");
	},
	volunteer: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.organization, jsonPath: `sections.volunteer.items[${i}].organization`, bold: true },
			{ value: item.location, jsonPath: `sections.volunteer.items[${i}].location` },
		]);
		emitPlainLine(b, item.period, `sections.volunteer.items[${i}].period`, { italic: true });
		emitRich(b, item.description, `sections.volunteer.items[${i}].description`);
		insertRaw(b, "\n");
	},
	references: (b, item, i) => {
		emitInlineRow(b, [
			{ value: item.name, jsonPath: `sections.references.items[${i}].name`, bold: true },
			{ value: item.phone, jsonPath: `sections.references.items[${i}].phone` },
		]);
		emitPlainLine(b, item.position, `sections.references.items[${i}].position`, { italic: true });
		emitRich(b, item.description, `sections.references.items[${i}].description`);
		insertRaw(b, "\n");
	},
};

function renderSection<T extends SectionType>(builder: Builder, sectionKey: T, section: SectionData<T>): void {
	if (section.hidden || section.items.length === 0) return;

	const title = section.title?.trim() || defaultSectionTitle(`sections.${sectionKey}.title`);
	emitSectionHeading(builder, title, `sections.${sectionKey}.title`);

	const renderer = itemRenderers[sectionKey];
	for (let i = 0; i < section.items.length; i++) {
		renderer(builder, section.items[i] as never, i, sectionKey);
	}
}

function renderPdfPreamble(builder: Builder, pdfUrl: string): void {
	const label = "Visual reference PDF (matches the rendered template):";
	const { start: labelStart, end: labelEnd } = insertRaw(builder, label);
	applyTextStyle(builder, labelStart, labelEnd, { italic: true });
	insertRaw(builder, " ");
	const linkText = "Open PDF";
	const { start: linkStart, end: linkEnd } = insertRaw(builder, linkText);
	applyTextStyle(builder, linkStart, linkEnd, {
		link: { url: pdfUrl },
		underline: true,
		foregroundColor: { color: { rgbColor: builder.primary } },
	});
	insertRaw(builder, "\n");
	const paragraphEnd = builder.cursor;
	applyParagraphStyle(
		builder,
		labelStart,
		paragraphEnd,
		{
			namedStyleType: "NORMAL_TEXT",
			spaceBelow: { magnitude: 8, unit: "PT" },
			borderBottom: {
				color: { color: { rgbColor: builder.primary } },
				width: { magnitude: 0.5, unit: "PT" },
				padding: { magnitude: 4, unit: "PT" },
				dashStyle: "DOT",
			},
		},
		"namedStyleType,spaceBelow,borderBottom",
	);
}

export function renderResumeToDoc(resume: ResumeData, options: { pdfUrl?: string } = {}): RenderResult {
	const builder = createBuilder(resume);

	if (options.pdfUrl) renderPdfPreamble(builder, options.pdfUrl);

	renderBasics(builder, resume.basics);
	renderSummary(builder, resume.summary);

	const sectionOrder: SectionType[] = [
		"experience",
		"education",
		"projects",
		"skills",
		"profiles",
		"languages",
		"interests",
		"awards",
		"certifications",
		"publications",
		"volunteer",
		"references",
	];
	for (const key of sectionOrder) {
		renderSection(builder, key, resume.sections[key] as never);
	}

	for (const [c, custom] of resume.customSections.entries()) {
		if (custom.hidden || custom.items.length === 0) continue;
		const title = custom.title?.trim() || "Custom Section";
		emitSectionHeading(builder, title, `customSections[${c}].title`);
		for (const [i, item] of custom.items.entries()) {
			if ("content" in item) {
				emitRich(builder, item.content as string, `customSections[${c}].items[${i}].content`);
			} else if ("name" in item && typeof item.name === "string") {
				emitPlainLine(builder, item.name, `customSections[${c}].items[${i}].name`);
			}
		}
	}

	const docStart = 1;
	const docEnd = builder.cursor;
	const bodyFontStyle = {
		updateTextStyle: {
			range: { startIndex: docStart, endIndex: docEnd },
			textStyle: { weightedFontFamily: { fontFamily: builder.fontBody, weight: 400 } },
			fields: "weightedFontFamily",
		},
	};

	return {
		requests: [...builder.insertions, bodyFontStyle, ...builder.style, ...builder.bulletOps],
		fieldMap: builder.fieldMap,
		plainText: builder.chunks.join(""),
	};
}
