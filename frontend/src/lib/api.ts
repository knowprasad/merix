import {
  CurrentUser,
  TokenResponse,
  Organisation,
  Job,
  JobSummary,
  Resume,
  BatchJob,
  MatchResult,
  MatchNote,
  ShortlistResponse,
  AuditEvent,
} from "./types";

/**
 * Resilient API base URL resolver.
 * Handles inputs with or without trailing slashes and with or without '/api' suffix.
 * Examples:
 *   - "https://merix-backend.onrender.com" -> "https://merix-backend.onrender.com/api"
 *   - "https://merix-backend.onrender.com/api/" -> "https://merix-backend.onrender.com/api"
 *   - "http://localhost:8000" -> "http://localhost:8000/api"
 */
export function getApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";
  let base = raw.trim().replace(/\/+$/, "");
  if (!base.endsWith("/api")) {
    base = `${base}/api`;
  }
  return base;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("merix_token");
}

export function setToken(token: string) {
  if (typeof window !== "undefined") {
    localStorage.setItem("merix_token", token);
  }
}

export function clearToken() {
  if (typeof window !== "undefined") {
    localStorage.removeItem("merix_token");
    localStorage.removeItem("merix_user");
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers || {});

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${cleanEndpoint}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Network error";
    throw new ApiError(
      `Unable to reach Merix backend at ${baseUrl}. Ensure the server is running and CORS allows this origin. (${errorMsg})`,
      0
    );
  }

  if (response.status === 204) {
    return {} as T;
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    if (typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      if (typeof d.detail === "string") {
        message = d.detail;
      } else if (Array.isArray(d.detail)) {
        message = d.detail.map((e: { msg?: string; loc?: string[] }) => `${e.loc?.join(".")}: ${e.msg}`).join(", ");
      } else if (d.error && typeof d.error === "object" && "message" in d.error) {
        message = String((d.error as { message: unknown }).message);
      }
    }
    throw new ApiError(message, response.status, data);
  }

  return data as T;
}

export const api = {
  // Auth
  async signup(orgName: string, email: string, password: string): Promise<TokenResponse> {
    const res = await request<TokenResponse>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ org_name: orgName, email, password }),
    });
    return res;
  },

  async login(email: string, password: string): Promise<TokenResponse> {
    const res = await request<TokenResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return res;
  },

  async getMe(): Promise<CurrentUser> {
    return request<CurrentUser>("/auth/me");
  },

  // Interest (public — pre-signup design-partner leads)
  async submitInterest(email: string, website = ""): Promise<{ status: string }> {
    return request<{ status: string }>("/interest", {
      method: "POST",
      body: JSON.stringify({ email, website }),
    });
  },

  // Organisations
  async getMyOrg(): Promise<Organisation> {
    return request<Organisation>("/orgs/me");
  },

  async updateMyOrg(retentionDays: number): Promise<Organisation> {
    return request<Organisation>("/orgs/me", {
      method: "PATCH",
      body: JSON.stringify({ retention_days: retentionDays }),
    });
  },

  // Jobs
  async listJobs(): Promise<JobSummary[]> {
    return request<JobSummary[]>("/jobs");
  },

  async createJob(title: string, rawText: string): Promise<Job> {
    return request<Job>("/jobs", {
      method: "POST",
      body: JSON.stringify({ title, raw_text: rawText }),
    });
  },

  async getJob(jobId: string): Promise<Job> {
    return request<Job>(`/jobs/${jobId}`);
  },

  // Resumes
  async uploadResume(
    jobId: string,
    file: File,
    candidateName?: string,
    consentGiven: boolean = true
  ): Promise<BatchJob> {
    const formData = new FormData();
    formData.append("file", file);
    if (candidateName) {
      formData.append("candidate_name", candidateName);
    }
    formData.append("consent_given", String(consentGiven));

    // Uploads are processed asynchronously: the endpoint validates consent,
    // size cap, and PDF integrity synchronously (rejecting bad uploads
    // immediately), then returns 202 Accepted with a BatchJobStatus whose
    // status can be polled via getBatchJobStatus until completed/failed.
    return request<BatchJob>(`/jobs/${jobId}/resumes`, {
      method: "POST",
      body: formData,
    });
  },

  async listJobResumes(jobId: string): Promise<Resume[]> {
    return request<Resume[]>(`/jobs/${jobId}/resumes`);
  },

  async getResume(jobId: string, resumeId: string): Promise<Resume> {
    return request<Resume>(`/jobs/${jobId}/resumes/${resumeId}`);
  },

  // Batch Matching
  async startBatchMatch(jobId: string, idempotencyKey?: string): Promise<BatchJob> {
    return request<BatchJob>(`/jobs/${jobId}/match`, {
      method: "POST",
      body: JSON.stringify(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });
  },

  async createBatchJob(jobId: string, _resumeIds?: string[]): Promise<BatchJob> {
    return this.startBatchMatch(jobId);
  },

  async getBatchJobStatus(arg1: string, arg2?: string): Promise<BatchJob> {
    const batchJobId = arg2 || arg1;
    return request<BatchJob>(`/batch-jobs/${batchJobId}`);
  },

  // Matches & Shortlists
  async listMatches(jobId: string, minScore?: number): Promise<ShortlistResponse> {
    const query = minScore !== undefined ? `?min_score=${minScore}` : "";
    return request<ShortlistResponse>(`/jobs/${jobId}/matches${query}`);
  },

  async getMatch(jobId: string, matchId: string): Promise<MatchResult> {
    // The single-match endpoint lives at /matches/{match_id} (matches router);
    // jobId is kept in the signature for caller symmetry but is not in the path.
    void jobId;
    return request<MatchResult>(`/matches/${matchId}`);
  },

  // Recruiter notes on a match (org-visible, timestamped, author-attributed)
  async listMatchNotes(matchId: string): Promise<MatchNote[]> {
    return request<MatchNote[]>(`/matches/${matchId}/notes`);
  },

  async createMatchNote(matchId: string, body: string): Promise<MatchNote> {
    return request<MatchNote>(`/matches/${matchId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },

  async bulkUpdateMatchStatus(
    jobId: string,
    matchIds: string[],
    status: "pending" | "shortlisted" | "rejected"
  ): Promise<{ updated: number }> {
    return request<{ updated: number }>(`/jobs/${jobId}/matches/status`, {
      method: "PATCH",
      body: JSON.stringify({ match_ids: matchIds, status }),
    });
  },

  async downloadMatchesCsv(jobId: string, minScore?: number): Promise<void> {
    const token = getToken();
    let url = `${getApiBaseUrl()}/jobs/${jobId}/matches/export`;
    const params = new URLSearchParams();
    if (minScore !== undefined) {
      params.set("min_score", String(minScore));
    }
    const queryString = params.toString();
    if (queryString) url += `?${queryString}`;

    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const text = await response.text();
      let message = `Request failed with status ${response.status}`;
      try {
        const data = JSON.parse(text) as { detail?: string };
        if (typeof data.detail === "string") message = data.detail;
      } catch {
        if (text) message = text;
      }
      throw new ApiError(message, response.status);
    }

    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `shortlist_${jobId}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  },

  // Candidate erasure (DPDP Right to Erasure)
  async deleteCandidate(jobId: string, resumeId: string): Promise<{ message: string }> {
    // The delete endpoint lives at /candidates/{resume_id} (candidates router);
    // jobId is kept in the signature for caller symmetry but is not in the path.
    void jobId;
    return request<{ message: string }>(`/candidates/${resumeId}`, {
      method: "DELETE",
    });
  },

  // Job deletion (HR pipeline management)
  async deleteJob(jobId: string): Promise<void> {
    await request<void>(`/jobs/${jobId}`, { method: "DELETE" });
  },

  // Audit Logs
  async listAuditLogs(limit?: number): Promise<AuditEvent[]> {
    const query = limit !== undefined ? `?limit=${limit}` : "";
    return request<AuditEvent[]>(`/orgs/audit-logs${query}`);
  },
};
