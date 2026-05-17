const DOCS_BASE = "https://docs.googleapis.com/v1";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

export class GoogleApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message: string,
	) {
		super(message);
		this.name = "GoogleApiError";
	}
}

async function googleFetch<T>(input: string, init: RequestInit, accessToken: string): Promise<T> {
	const headers = new Headers(init.headers ?? {});
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

	const response = await fetch(input, { ...init, headers });
	if (!response.ok) {
		let body: unknown = await response.text();
		try {
			body = JSON.parse(body as string);
		} catch {
			// keep text body
		}
		const bodyExcerpt = typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500);
		throw new GoogleApiError(
			response.status,
			body,
			`${init.method ?? "GET"} ${input} -> ${response.status}: ${bodyExcerpt}`,
		);
	}

	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export type DocsRequest = Record<string, unknown>;

type CreateDocumentResponse = {
	documentId: string;
	title: string;
	revisionId: string;
};

export async function createDocument(accessToken: string, title: string): Promise<CreateDocumentResponse> {
	return googleFetch<CreateDocumentResponse>(
		`${DOCS_BASE}/documents`,
		{ method: "POST", body: JSON.stringify({ title }) },
		accessToken,
	);
}

type GetDocumentResponse = {
	documentId: string;
	title: string;
	body: { content: { endIndex?: number; startIndex?: number }[] };
};

export async function getDocument(accessToken: string, documentId: string): Promise<GetDocumentResponse> {
	return googleFetch<GetDocumentResponse>(
		`${DOCS_BASE}/documents/${encodeURIComponent(documentId)}?fields=documentId,title,body(content(startIndex,endIndex))`,
		{ method: "GET" },
		accessToken,
	);
}

export function getBodyEndIndex(doc: GetDocumentResponse): number {
	let end = 1;
	for (const segment of doc.body?.content ?? []) {
		if (typeof segment.endIndex === "number" && segment.endIndex > end) end = segment.endIndex;
	}
	return end;
}

type BatchUpdateResponse = {
	documentId: string;
	replies: Record<string, unknown>[];
	writeControl: { requiredRevisionId?: string };
};

export async function batchUpdate(
	accessToken: string,
	documentId: string,
	requests: DocsRequest[],
): Promise<BatchUpdateResponse> {
	return googleFetch<BatchUpdateResponse>(
		`${DOCS_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
		{ method: "POST", body: JSON.stringify({ requests }) },
		accessToken,
	);
}

export type DrivePermissionRole = "reader" | "commenter" | "writer";

type CreatePermissionResponse = {
	id: string;
	type: string;
	role: DrivePermissionRole;
	emailAddress?: string;
};

export async function shareFileWithEmail(
	accessToken: string,
	fileId: string,
	email: string,
	role: DrivePermissionRole = "commenter",
	options: { sendNotificationEmail?: boolean; emailMessage?: string } = {},
): Promise<CreatePermissionResponse> {
	const params = new URLSearchParams();
	if (options.sendNotificationEmail !== undefined) {
		params.set("sendNotificationEmail", String(options.sendNotificationEmail));
	}
	if (options.emailMessage) params.set("emailMessage", options.emailMessage);

	const query = params.toString();
	const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions${query ? `?${query}` : ""}`;

	return googleFetch<CreatePermissionResponse>(
		url,
		{
			method: "POST",
			body: JSON.stringify({ type: "user", role, emailAddress: email }),
		},
		accessToken,
	);
}

export function buildDocumentUrl(documentId: string): string {
	return `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`;
}

export function buildDriveFileUrl(fileId: string): string {
	return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

type DriveFile = { id: string; name: string; mimeType: string; webViewLink?: string };

export async function createDriveFile(
	accessToken: string,
	input: { name: string; mimeType: string; data: Uint8Array | ArrayBuffer | Buffer },
): Promise<DriveFile> {
	const boundary = `----rxr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const metadata = { name: input.name, mimeType: input.mimeType };

	const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`;
	const tail = `\r\n--${boundary}--`;

	const headBytes = Buffer.from(head, "utf8");
	const tailBytes = Buffer.from(tail, "utf8");
	const fileBytes = input.data instanceof Buffer ? input.data : Buffer.from(input.data as ArrayBuffer);
	const body = Buffer.concat([headBytes, fileBytes, tailBytes]);

	const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": `multipart/related; boundary=${boundary}`,
			"Content-Length": String(body.length),
		},
		body,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new GoogleApiError(response.status, text, `POST upload/files -> ${response.status}: ${text.slice(0, 500)}`);
	}
	return (await response.json()) as DriveFile;
}

export async function updateDriveFileMedia(
	accessToken: string,
	fileId: string,
	input: { mimeType: string; data: Uint8Array | ArrayBuffer | Buffer },
): Promise<DriveFile> {
	const fileBytes = input.data instanceof Buffer ? input.data : Buffer.from(input.data as ArrayBuffer);
	const url = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,webViewLink`;
	const response = await fetch(url, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": input.mimeType,
			"Content-Length": String(fileBytes.length),
		},
		body: fileBytes,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new GoogleApiError(response.status, text, `PATCH upload/files/${fileId} -> ${response.status}: ${text.slice(0, 500)}`);
	}
	return (await response.json()) as DriveFile;
}

export async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
	try {
		await googleFetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, accessToken);
	} catch (err) {
		if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
		throw err;
	}
}

export type DriveComment = {
	id: string;
	content: string;
	htmlContent?: string;
	resolved: boolean;
	anchor?: string;
	quotedFileContent?: { mimeType: string; value: string };
	author?: { displayName?: string; emailAddress?: string };
	createdTime?: string;
	modifiedTime?: string;
};

type ListCommentsResponse = {
	comments: DriveComment[];
	nextPageToken?: string;
};

export async function listComments(accessToken: string, fileId: string): Promise<DriveComment[]> {
	const comments: DriveComment[] = [];
	let pageToken: string | undefined;
	const fields =
		"nextPageToken,comments(id,content,htmlContent,resolved,anchor,quotedFileContent,author(displayName,emailAddress),createdTime,modifiedTime)";
	do {
		const params = new URLSearchParams({ fields, pageSize: "100", includeDeleted: "false" });
		if (pageToken) params.set("pageToken", pageToken);
		const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/comments?${params.toString()}`;
		const response = await googleFetch<ListCommentsResponse>(url, { method: "GET" }, accessToken);
		if (response.comments) comments.push(...response.comments);
		pageToken = response.nextPageToken;
	} while (pageToken);
	return comments;
}

export async function deleteComment(accessToken: string, fileId: string, commentId: string): Promise<void> {
	try {
		await googleFetch(
			`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`,
			{ method: "DELETE" },
			accessToken,
		);
	} catch (err) {
		if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
		throw err;
	}
}
