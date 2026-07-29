// Google Drive API client for the vault sync engine.
// Handles auth, folder creation, file uploads, and path caching.

const VAULT_ROOT = "smriti-vault";
const MAX_CALLS_PER_ROUND = 50;

let _apiCallsThisRound = 0;

export function getApiCallsThisRound(): number {
  return _apiCallsThisRound;
}

export function resetApiCallCount(): void {
  _apiCallsThisRound = 0;
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface PathCacheEntry {
  path: string;           // e.g. "threads/claude"
  folderId: string;       // Google Drive folder ID
  cachedAt: number;       // Date.now() when cached
}

export interface DriveFileResult {
  fileId: string;         // Google Drive file ID
  name: string;           // filename on Drive
  webViewLink?: string;   // shareable link (if available)
}

export class DriveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _tokenExpiry = 0;

export async function getAuthToken(interactive = false): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) {
    return _cachedToken;
  }

  const result = await chrome.identity.getAuthToken({ interactive });
  if (!result.token) throw new Error("No auth token received");

  _cachedToken = result.token;
  // Chrome tokens are valid for ~60 minutes
  _tokenExpiry = Date.now() + 55 * 60 * 1000;
  return _cachedToken;
}

export async function revokeAuthToken(): Promise<void> {
  if (_cachedToken) {
    await chrome.identity.removeCachedAuthToken({ token: _cachedToken });

    // Also revoke token on Google's end
    try {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${_cachedToken}`);
    } catch { /* best effort */ }

    _cachedToken = null;
    _tokenExpiry = 0;
  }
}

export function hasValidToken(): boolean {
  return _cachedToken !== null && Date.now() < _tokenExpiry - 60_000;
}

// ─── Path Cache ─────────────────────────────────────────────────────────

const CACHE_STORAGE_KEY = "smriti:drive_path_cache";
const pathCache = new Map<string, PathCacheEntry>();

export function getCachedFolderId(vaultPath: string): string | null {
  const entry = pathCache.get(vaultPath);
  return entry ? entry.folderId : null;
}

export async function persistPathCache(): Promise<void> {
  const entries = [...pathCache.values()];
  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: entries });
}

export async function loadPathCache(): Promise<void> {
  const obj = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  const entries = obj[CACHE_STORAGE_KEY] as PathCacheEntry[] | undefined;
  pathCache.clear();
  if (Array.isArray(entries)) {
    // Discard entries older than 24 hours (folder could have been deleted)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const e of entries) {
      if (e.cachedAt > cutoff) pathCache.set(e.path, e);
    }
  }
}

export function clearPathCache(): void {
  pathCache.clear();
}

// ─── Folder operations ──────────────────────────────────────────────────

export async function ensureFolder(vaultPath: string): Promise<string> {
  // Check if target path is already cached
  const cachedId = getCachedFolderId(vaultPath);
  if (cachedId) return cachedId;

  // Split path into segments (e.g. "threads/claude" -> ["threads", "claude"])
  const segments = vaultPath.split("/").filter(Boolean);

  // First ensure root folder exists
  let currentParentId = getCachedFolderId("root");
  if (!currentParentId) {
    currentParentId = await findOrCreateFolder(VAULT_ROOT, "root");
    pathCache.set("root", {
      path: "root",
      folderId: currentParentId,
      cachedAt: Date.now()
    });
  }

  // Then traverse and create segments
  let currentPath = "";
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;

    const segmentCachedId = getCachedFolderId(currentPath);
    if (segmentCachedId) {
      currentParentId = segmentCachedId;
    } else {
      currentParentId = await findOrCreateFolder(segment, currentParentId);
      pathCache.set(currentPath, {
        path: currentPath,
        folderId: currentParentId,
        cachedAt: Date.now()
      });
    }
  }

  return currentParentId;
}

async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const token = await getAuthToken();

  // Search for existing folder
  // Note: if parentId is "root", we just omit the parents clause or use 'root'
  const parentClause = parentId === "root" ? "'root' in parents" : `'${parentId}' in parents`;
  // Double single quotes to escape single quotes in name (Google Drive API escaping)
  const escapedName = name.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and ${parentClause} and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const searchRes = await fetchWithRetry(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const searchJson = await searchRes.json();

  if (searchJson.files?.length > 0) {
    return searchJson.files[0].id;
  }

  // Create the folder
  const createRes = await fetchWithRetry(
    "https://www.googleapis.com/drive/v3/files?fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId !== "root" ? { parents: [parentId] } : {}),
      }),
    },
  );
  const createJson = await createRes.json();
  return createJson.id;
}

// ─── File operations ────────────────────────────────────────────────────

export async function findFile(parentFolderId: string, filename: string): Promise<string | null> {
  const token = await getAuthToken();
  const escapedName = filename.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and '${parentFolderId}' in parents and trashed=false`;

  const res = await fetchWithRetry(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();

  if (json.files?.length > 0) {
    return json.files[0].id;
  }
  return null;
}

export async function uploadFile(
  parentFolderId: string,
  filename: string,
  content: string,
  mimeType = "text/markdown",
): Promise<DriveFileResult> {
  const token = await getAuthToken();
  const boundary = "smriti_boundary_" + Date.now();

  const metadata = JSON.stringify({
    name: filename,
    mimeType,
    parents: [parentFolderId],
  });

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await fetchWithRetry(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  const json = await res.json();
  return { fileId: json.id, name: json.name, webViewLink: json.webViewLink };
}

export async function updateFile(
  fileId: string,
  content: string,
  mimeType = "text/markdown"
): Promise<DriveFileResult> {
  const token = await getAuthToken();

  // Use simple upload for update if just updating content
  const res = await fetchWithRetry(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,webViewLink`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: content,
    },
  );

  const json = await res.json();
  return { fileId: json.id, name: json.name, webViewLink: json.webViewLink };
}

// ─── Core fetch with retry logic ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | null = null;

  if (_apiCallsThisRound >= MAX_CALLS_PER_ROUND) {
    throw new DriveApiError(
      `Exceeded max API calls per round (${MAX_CALLS_PER_ROUND}). Aborting to protect quota.`,
      429,
      false
    );
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      _apiCallsThisRound++;
      const res = await fetch(url, init);

      if (res.ok) return res;

      // 401: Token expired — refresh and retry once
      if (res.status === 401 && attempt === 0) {
        if (_cachedToken) {
          await chrome.identity.removeCachedAuthToken({ token: _cachedToken });
        }
        _cachedToken = null;
        _tokenExpiry = 0;

        // Try silent refresh
        try {
          const newToken = await getAuthToken(false);
          // Patch the Authorization header
          const headers = new Headers(init.headers);
          headers.set("Authorization", `Bearer ${newToken}`);
          init = { ...init, headers };
          continue;
        } catch {
          // If silent refresh fails, the user must re-auth interactively from Settings
          throw new DriveApiError("Token expired and silent refresh failed", 401, false);
        }
      }

      // 403: Check if rate limit exceeded
      if (res.status === 403) {
        const text = await res.clone().text().catch(() => "");
        if (text.includes("rateLimitExceeded") || text.includes("userRateLimitExceeded")) {
          throw new DriveApiError("Google Drive API rate limit exceeded", 403, false);
        }
      }

      // 404: Not found (might happen if path cache is stale)
      if (res.status === 404) {
        throw new DriveApiError("Resource not found", 404, false);
      }

      // 429: Rate limited — use Retry-After header
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5");
        await sleep(retryAfter * 1000);
        continue;
      }

      // 5xx: Server error — exponential backoff
      if (res.status >= 500) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      // 4xx (not 401/404/429): Non-retryable
      const text = await res.text().catch(() => "");
      throw new DriveApiError(
        `Drive API ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        false,
      );
    } catch (e) {
      if (e instanceof DriveApiError && !e.retryable) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw lastError ?? new Error("Drive API request failed after retries");
}
