export interface CurrentUser {
  id: string;
  email: string;
  org_id: string;
  org_name: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  user_id: string;
  org_id: string;
}

export interface Organisation {
  id: string;
  name: string;
  retention_days: number;
}

export interface Job {
  id: string;
  title: string;
  raw_text: string;
  parsed?: {
    required_skills?: string[];
    preferred_skills?: string[];
    min_years_experience?: number;
    education_level?: string;
    summary?: string;
  } | null;
  created_at: string;
  resume_count?: number;
  match_count?: number;
}

export interface JobSummary {
  id: string;
  title: string;
  created_at: string;
  resume_count: number;
  match_count: number;
  shortlisted_count?: number;
  parsed?: {
    required_skills?: string[];
    preferred_skills?: string[];
    min_years_experience?: number;
    education_level?: string;
    summary?: string;
  } | null;
}

export interface ResumeLink {
  url: string;
  type: "linkedin" | "github" | "gitlab" | "bitbucket" | "portfolio" | "blog" | "other";
}

export interface TimelineSpan {
  company: string;
  title: string;
  start_year: number;
  end_year: number;
  end_open: boolean;
}

export interface TimelineAnalysis {
  total_experience_years: number;
  spans: TimelineSpan[];
  overlaps: string[][];
  gaps: Array<{ after_year: number; months: number }>;
  flags: string[];
}

export interface LinkVerification {
  url: string;
  status: "ok" | "dead" | "error" | "skipped" | "unknown" | "fabricated";
  http_status?: number | null;
  github_profile?: "ok" | "dead" | "unknown";
  checked_at?: string | null;
}


export interface Resume {
  id: string;
  job_id: string;
  original_filename: string;
  candidate_name?: string | null;
  consent_given: boolean;
  consent_timestamp?: string;
  retention_expires_at?: string;
  created_at: string;
  parsed?: {
    candidate_name?: string;
    email?: string;
    skills?: string[];
    years_experience?: number;
    education?: string;
    work_history?: string[];
    links?: ResumeLink[];
    timeline_analysis?: TimelineAnalysis;
    link_verification?: LinkVerification[];

  } | null;
}


export interface BatchJob {
  id: string;
  org_id: string;
  job_description_id: string;
  status: "queued" | "running" | "completed" | "failed";
  idempotency_key?: string | null;
  total_resumes: number;
  completed_resumes: number;
  batch_results?: Array<{
    resume_id: string;
    candidate_name?: string;
    status: "completed" | "failed";
    score?: number;
    error?: string;
  }> | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchedSkill {
  skill: string;
  required: boolean;
  evidence: string;
  /** "exact" = normalized string equality; "adjacent" = semantic fallback.
   *  Absent on legacy rows -> treat as exact. */
  match_type?: "exact" | "adjacent";
  /** Adjacent only: the JD skill this resume skill satisfies. */
  similar_to?: string | null;
  /** Adjacent only: cosine similarity (0-1). */
  similarity?: number | null;
}

export interface MissingSkill {
  skill: string;
  required: boolean;
}

export interface MatchResult {
  id: string;
  job_id: string;
  resume_id: string;
  candidate_name?: string | null;
  score: number;
  matched_skills: MatchedSkill[];
  missing_skills: MissingSkill[];
  rationale: string;
  status?: "pending" | "shortlisted" | "rejected";
  created_at: string;
}

export interface ShortlistResponse {
  job_id: string;
  count: number;
  results: MatchResult[];
}

export interface MatchNote {
  id: string;
  match_id: string;
  author_id: string | null;
  author_email: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  event_type: string;
  actor_type: string;
  actor_user_id?: string | null;
  resume_id?: string | null;
  event_metadata?: Record<string, unknown> | null;
  created_at: string;
}
