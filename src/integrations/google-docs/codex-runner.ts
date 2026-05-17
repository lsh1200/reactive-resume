import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ResumeData } from "@/schema/resume/data";
import { logger } from "@/utils/logger";

function resolveCodexBinary(): { command: string; useShell: boolean } {
	const explicit = process.env.CODEX_BIN?.trim();
	if (explicit && existsSync(explicit)) {
		return { command: explicit, useShell: false };
	}

	if (platform() === "win32") {
		const extensionsDir = join(homedir(), ".vscode", "extensions");
		if (existsSync(extensionsDir)) {
			try {
				const matches = readdirSync(extensionsDir)
					.filter((name) => name.startsWith("openai.chatgpt-") && name.endsWith("-win32-x64"))
					.sort()
					.reverse();
				for (const name of matches) {
					const candidate = join(extensionsDir, name, "bin", "windows-x86_64", "codex.exe");
					if (existsSync(candidate)) return { command: candidate, useShell: false };
				}
			} catch {
				// fall through
			}
		}
	}

	return { command: "codex", useShell: platform() === "win32" };
}

export type CommentForCodex = {
	id: string;
	jsonPath: string | null;
	anchoredText: string | null;
	commentText: string;
	authorName: string | null;
};

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

const proposalSchema = z.object({
	title: z.string().min(1).describe("Short imperative summary of the change, e.g. 'Tighten summary headline'."),
	jsonPath: z.string().min(1).describe("Dotted path within resume.data, e.g. 'sections.experience.items[0].description'."),
	before: jsonValueSchema.describe("Current value at jsonPath. Echo it exactly."),
	after: jsonValueSchema.describe("Proposed new value at jsonPath."),
	commentIds: z.array(z.string()).min(1).describe("ids of the comments this change addresses (use the ids provided in the prompt)."),
	reasoning: z.string().optional().describe("Optional one-line explanation."),
});

export type CodexProposal = z.infer<typeof proposalSchema>;

const proposalsResponseSchema = z.object({
	proposals: z.array(proposalSchema),
	notes: z.string().optional(),
});

export type CodexProposalsResult = {
	proposals: CodexProposal[];
	notes: string | null;
	rawStdout: string;
	rawStderr: string;
	durationMs: number;
};

export class CodexRunError extends Error {
	constructor(
		message: string,
		public readonly stage: "spawn" | "exit" | "timeout" | "parse" | "validate",
		public readonly stdout?: string,
		public readonly stderr?: string,
	) {
		super(message);
		this.name = "CodexRunError";
	}
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function buildPrompt(resume: ResumeData, comments: CommentForCodex[]): string {
	const commentBlocks = comments
		.map((c, i) => {
			const path = c.jsonPath?.trim().length ? c.jsonPath : "(unmapped — infer from anchored text)";
			const anchor = c.anchoredText?.trim() || "(no anchored text)";
			return `### Comment ${i + 1}
- id: ${c.id}
- Mapped field: ${path}
- Anchored text: ${JSON.stringify(anchor)}
- Recruiter (${c.authorName ?? "anonymous"}): ${c.commentText.trim()}`;
		})
		.join("\n\n");

	return `You are reviewing recruiter feedback on a Reactive Resume v5 JSON document. Your job is to propose a list of concrete edits the user can accept or reject — one at a time.

# OUTPUT CONTRACT
Output EXACTLY one JSON object with this shape, and nothing else (no markdown fences, no prose):
{
  "proposals": [
    {
      "title": "<short imperative summary>",
      "jsonPath": "<dotted path inside resume.data>",
      "commentIds": ["<id of the comment(s) this addresses>"],
      "before": <current value at jsonPath, echoed exactly>,
      "after": <proposed new value at jsonPath>,
      "reasoning": "<optional one-line explanation>"
    }
  ],
  "notes": "<optional free-form note about anything you skipped or assumed>"
}

# RULES
1. Each proposal is a SINGLE field change at one jsonPath. If a comment requires multiple changes (e.g. rewording in two bullets), emit multiple proposals — each one independently applyable.
2. One comment → one or more proposals. Multiple comments may share a proposal if and only if they all reference the same field.
3. The "after" value must match the schema of the "before" value (string→string, array→array, object→object). Strings that contain HTML stay HTML.
4. Do NOT invent facts. Do not introduce new jobs, schools, companies, dates, locations, awards, certifications, publications, skills, languages, or quantitative claims that aren't already in the input or in the recruiter's comment text.
5. If a comment says "move section X under section Y", emit a proposal targeting \`metadata.layout.pages[N].main\` and/or \`.sidebar\` with the new arrays.
6. HTML fields use TipTap HTML. Valid tags: <p>, <strong>, <em>, <u>, <a href="…">, <ul>, <ol>, <li>, <br>. Preserve bullet lists as <ul><li>…</li></ul>, paragraphs as <p>…</p>. No raw newlines inside HTML; use </p><p> or <br>.
7. Roughly preserve length and bullet count unless the comment explicitly asks otherwise.
8. If you cannot honor a comment without violating these rules (e.g. it asks for invented data), skip it and explain in the top-level "notes" field. Do NOT emit a proposal that does nothing.
9. Title must be imperative and human-readable, ≤ 80 chars, e.g. "Tighten Hirose bullet 1" or "Move Skills section to sidebar".
10. "before" must echo the CURRENT value of the field exactly. The frontend uses it to verify nothing drifted.

# FIELD HINTS
- \`basics.headline\` is one short line, no HTML.
- \`sections.experience.items[*].description\` / \`.roles[*].description\` are <ul><li>…</li></ul>.
- \`sections.skills.items[*].keywords\` is a plain string array.
- \`metadata.layout.pages[*].main\` and \`metadata.layout.pages[*].sidebar\` are string arrays of section ids.

# CURRENT resume.data
\`\`\`json
${JSON.stringify(resume)}
\`\`\`

# RECRUITER COMMENTS
${commentBlocks}

Output the JSON object now.`;
}

function extractJson(stdout: string): string | null {
	const trimmed = stdout.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

	const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	if (fenceMatch) return fenceMatch[1].trim();

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}
	return null;
}

function extractFinalAssistantJson(stdout: string): string | null {
	const lines = stdout.split(/\r?\n/);
	let finalText: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const event = JSON.parse(trimmed) as {
				type?: string;
				item?: { type?: string; text?: string; content?: string };
				msg?: { type?: string; message?: string; text?: string };
				text?: string;
			};
			const itemType = event.item?.type ?? event.msg?.type ?? event.type;
			if (
				itemType === "agent_message" ||
				itemType === "assistant_message" ||
				itemType === "agent_message_delta"
			) {
				const text =
					event.item?.text ?? event.item?.content ?? event.msg?.message ?? event.msg?.text ?? event.text;
				if (typeof text === "string" && text.includes("{")) {
					finalText = text;
				}
			}
		} catch {
			// not a JSON event line; ignore
		}
	}
	if (!finalText) return null;
	return extractJson(finalText);
}

export async function runCodexProposals(input: {
	resume: ResumeData;
	comments: CommentForCodex[];
	timeoutMs?: number;
	command?: string;
}): Promise<CodexProposalsResult> {
	const prompt = buildPrompt(input.resume, input.comments);
	const resolved = input.command ? { command: input.command, useShell: false } : resolveCodexBinary();
	const args = ["exec", "--skip-git-repo-check", "--json"];
	const startedAt = Date.now();

	logger.info("Spawning Codex (proposals)", { command: resolved.command, useShell: resolved.useShell });

	return new Promise<CodexProposalsResult>((resolve, reject) => {
		let child;
		try {
			child = spawn(resolved.command, args, {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: resolved.useShell,
			});
		} catch (err) {
			reject(
				new CodexRunError(
					`Failed to spawn ${resolved.command}: ${err instanceof Error ? err.message : String(err)}`,
					"spawn",
				),
			);
			return;
		}

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new CodexRunError(
					`Codex run exceeded ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
					"timeout",
					stdout,
					stderr,
				),
			);
		}, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		if (child.stdin) {
			child.stdin.on("error", () => {
				// pipe closed; ignore
			});
			child.stdin.write(prompt, "utf8", () => {
				child.stdin?.end();
			});
		}

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new CodexRunError(`Codex spawn error: ${err.message}`, "spawn", stdout, stderr));
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			const durationMs = Date.now() - startedAt;
			if (code !== 0) {
				logger.warn("Codex exited non-zero", { code, stderr: stderr.slice(0, 400) });
				reject(new CodexRunError(`Codex exited with code ${code}`, "exit", stdout, stderr));
				return;
			}

			const finalJson = extractFinalAssistantJson(stdout) ?? extractJson(stdout);
			if (!finalJson) {
				reject(new CodexRunError("Could not find JSON in Codex output", "parse", stdout, stderr));
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(finalJson);
			} catch (err) {
				reject(
					new CodexRunError(
						`Failed to JSON.parse Codex output: ${err instanceof Error ? err.message : String(err)}`,
						"parse",
						stdout,
						stderr,
					),
				);
				return;
			}

			const validated = proposalsResponseSchema.safeParse(parsed);
			if (!validated.success) {
				reject(
					new CodexRunError(
						`Codex output failed schema validation: ${validated.error.message.slice(0, 500)}`,
						"validate",
						stdout,
						stderr,
					),
				);
				return;
			}

			resolve({
				proposals: validated.data.proposals,
				notes: validated.data.notes ?? null,
				rawStdout: stdout,
				rawStderr: stderr,
				durationMs,
			});
		});
	});
}
