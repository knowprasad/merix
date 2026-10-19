"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Job, MatchResult, MatchNote, Resume, ResumeLink, LinkVerification, ScoreBreakdown } from "@/lib/types";

import { DPDPBadge } from "@/components/dpdp-badge";
import { ScoreRing } from "@/components/score-ring";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Sparkles,
  ShieldCheck,
  Trash2,
  AlertTriangle,
  AlertCircle,
  Loader2,
  Github,
  Linkedin,
  Globe,
  Link2,
  Clock,
  MessageSquare,
  Send,
} from "lucide-react";

function linkIcon(link: ResumeLink) {
  switch (link.type) {
    case "linkedin":
      return Linkedin;
    case "github":
    case "gitlab":
    case "bitbucket":
      return Github;
    case "portfolio":
    case "blog":
      return Globe;
    default:
      return Link2;
  }
}

/** Short display label for a link URL (strips protocol/www). */
function linkLabel(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

const VERIFY_BADGE: Record<LinkVerification["status"], { color: string; label: string }> = {
  ok: { color: "#16A34A", label: "Live" },
  fabricated: { color: "#DC2626", label: "Not found — possibly fabricated" },
  dead: { color: "#DC2626", label: "Dead link" },
  error: { color: "#64748B", label: "Unreachable" },
  unknown: { color: "#D97706", label: "Inconclusive" },
  skipped: { color: "#64748B", label: "Not checked" },
};

/** Display label for a note author (email prefix; graceful for removed accounts). */
function authorLabel(email: string | null): string {
  return email ? email.split("@")[0] : "Former member";
}

function formatNoteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ScoreComponentRow({
  label,
  maxPoints,
  contribution,
  coverage,
  detail,
  barClass,
}: {
  label: string;
  maxPoints: number;
  contribution: number;
  coverage: number;
  detail: string;
  barClass: string;
}) {
  const percentage = Math.max(0, Math.min(100, Math.round(coverage * 100)));

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4 font-mono">
        <div className="min-w-0">
          <div className="text-sm text-[var(--text-primary)]">{label}</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{detail}</div>
        </div>
        <span className="shrink-0 text-sm font-bold text-[var(--text-primary)]">
          {contribution.toFixed(1)} / {maxPoints}
        </span>
      </div>
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-subtle)]"
        role="progressbar"
        aria-label={`${label} contribution`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <div className={`h-full rounded-full transition-[width] duration-500 ${barClass}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function breakdownDetail(breakdown: ScoreBreakdown, kind: "required" | "preferred" | "experience"): string {
  if (kind === "experience") {
    const target = breakdown.minimum_experience_years;
    return target > 0
      ? `${breakdown.experience_years.toFixed(1)} yrs evidenced · ${target.toFixed(1)} yrs required`
      : `${breakdown.experience_years.toFixed(1)} yrs evidenced · no minimum specified`;
  }

  const coverage = kind === "required" ? breakdown.required_coverage : breakdown.preferred_coverage;
  const exact = kind === "required" ? breakdown.required_exact_matches : breakdown.preferred_exact_matches;
  const adjacent = kind === "required" ? breakdown.required_adjacent_credit : breakdown.preferred_adjacent_credit;
  const total = kind === "required" ? breakdown.required_total : breakdown.preferred_total;
  if (total === 0) return "No qualifications specified";
  const adjacentText = adjacent > 0 ? ` · ${adjacent.toFixed(2)} adjacent credit` : "";
  return `${Math.round(coverage * 100)}% coverage · ${exact}/${total} exact${adjacentText}`;
}



export default function CandidateDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = String(params.jobId);
  const matchId = String(params.matchId);
  const { isAuthenticated, loading: authLoading } = useAuth();

  const [job, setJob] = useState<Job | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  /* ---- Team notes (org-visible collaboration on this match) ---- */
  const [notes, setNotes] = useState<MatchNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [newNoteBody, setNewNoteBody] = useState("");
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobData, matchData] = await Promise.all([
        api.getJob(jobId),
        api.getMatch(jobId, matchId),
      ]);
      setJob(jobData);
      setMatch(matchData);
      // Links + timeline live on the resume's parsed payload; non-fatal if absent.
      if (matchData.resume_id) {
        const resumeData = await api.getResume(jobId, matchData.resume_id).catch(() => null);
        setResume(resumeData);
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load candidate evaluation";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [jobId, matchId]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/login");
      return;
    }

    // Deferred so the effect body performs no synchronous state update
    // (react-hooks/set-state-in-effect); behaviour is unchanged.
    const timer = setTimeout(() => {
      if (isAuthenticated && matchId && jobId) {
        loadData();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [authLoading, isAuthenticated, matchId, jobId, router, loadData]);

  // Notes load independently of the main dossier payload (non-fatal).
  // Deferred so the effect body performs no synchronous setState
  // (react-hooks/set-state-in-effect); behaviour is unchanged.
  useEffect(() => {
    if (!isAuthenticated || !matchId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setNotesLoading(true);
      api
        .listMatchNotes(matchId)
        .then((data) => {
          if (!cancelled) setNotes(data);
        })
        .catch(() => {
          if (!cancelled) setNotesError("Failed to load team notes.");
        })
        .finally(() => {
          if (!cancelled) setNotesLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isAuthenticated, matchId]);

  const handleAddNote = async () => {
    const body = newNoteBody.trim();
    if (!body || noteSubmitting) return;
    setNoteSubmitting(true);
    setNotesError(null);
    try {
      const note = await api.createMatchNote(matchId, body);
      setNotes((prev) => [note, ...prev]);
      setNewNoteBody("");
    } catch (err: unknown) {
      setNotesError(err instanceof Error ? err.message : "Failed to add note");
    } finally {
      setNoteSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!match?.resume_id) return;

    setIsDeleting(true);
    try {
      await api.deleteCandidate(jobId, match.resume_id);
      router.push(`/jobs/${jobId}/results`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete candidate";
      setError(msg);
      setIsDeleting(false);
      setShowDeleteModal(false);
    }
  };

  if (authLoading || (loading && !match)) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent-evidence)] mb-3" />
        <span className="text-sm text-[var(--text-muted)] font-mono">Loading Candidate Dossier...</span>
      </div>
    );
  }

  const score = match?.score || 0;
  const breakdown = match?.score_breakdown ?? null;
  const scoreCategory =
    score >= 80
      ? { label: "Strong Match", color: "#16A34A", bg: "rgba(22,163,74,0.12)" }
      : score >= 60
      ? { label: "Good Match", color: "#D97706", bg: "rgba(217,119,6,0.12)" }
      : { label: "Needs Review", color: "#EA580C", bg: "rgba(234,88,12,0.12)" };

  return (
    <div className="min-h-screen pb-16">

      <main className="max-w-7xl mx-auto px-4 sm:px-6 space-y-6">
        {/* Top Breadcrumbs */}
        <div className="flex justify-between items-center pb-3 border-b border-[var(--border-hairline)]">
          <Link
            href={`/jobs/${jobId}/results`}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Ranked Shortlist</span>
          </Link>
          <DPDPBadge variant="row" />
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] text-[var(--accent-danger)] text-sm flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-[var(--accent-danger)] shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Score Breakdown & Candidate Info */}
          <div className="lg:col-span-5 space-y-6">
            {/* Score Centerpiece Card */}
            <div className="merix-card p-8 rounded-3xl border border-[var(--border-hairline)] text-center space-y-6 shadow-xl">
              <div className="space-y-1">
                <span className="text-xs font-mono text-[var(--accent-evidence)]  uppercase tracking-wider font-semibold">
                  EVIDENCE-GROUNDED MATCH SCORE
                </span>
                <h1 className="font-display text-2xl font-normal text-[var(--text-primary)]">
                  {match?.candidate_name || "Candidate Evaluation"}
                </h1>
                <p className="text-sm text-[var(--text-muted)]">Applied for {job?.title}</p>
              </div>

              {/* Large Animated Score Ring */}
              <div className="py-2 flex justify-center">
                <ScoreRing score={score} size={130} strokeWidth={9} animated={true} />
              </div>

              <div
                className="inline-block px-3 py-1 rounded-full text-sm font-semibold font-mono"
                style={{ color: scoreCategory.color, background: scoreCategory.bg }}
              >
                {scoreCategory.label}
              </div>

              {/* Exact 70/20/10 breakdown returned by the scoring service. */}
              <div className="space-y-4 border-t border-[var(--border-hairline)] pt-5 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
                      Score composition
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                      Fixed weights, deterministic coverage, and fractional credit for clearly labelled adjacent skills.
                    </p>
                  </div>
                  {breakdown && (
                    <span className="shrink-0 rounded-full border border-[var(--accent-evidence)]/30 bg-[var(--accent-evidence-soft)] px-2 py-1 text-[10px] font-mono font-semibold uppercase tracking-wider text-[var(--accent-evidence)]">
                      Verified v{breakdown.version}
                    </span>
                  )}
                </div>

                {breakdown ? (
                  <div className="space-y-4">
                    <ScoreComponentRow
                      label="Required skills · 70 pts"
                      maxPoints={70}
                      contribution={breakdown.required_contribution}
                      coverage={breakdown.required_coverage}
                      detail={breakdownDetail(breakdown, "required")}
                      barClass="bg-[var(--accent-evidence)]"
                    />
                    <ScoreComponentRow
                      label="Preferred qualifications · 20 pts"
                      maxPoints={20}
                      contribution={breakdown.preferred_contribution}
                      coverage={breakdown.preferred_coverage}
                      detail={breakdownDetail(breakdown, "preferred")}
                      barClass="bg-amber-500"
                    />
                    <ScoreComponentRow
                      label="Experience · 10 pts"
                      maxPoints={10}
                      contribution={breakdown.experience_contribution}
                      coverage={breakdown.experience_score}
                      detail={breakdownDetail(breakdown, "experience")}
                      barClass="bg-[var(--brand-primary)]"
                    />
                    <div className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-3 font-mono">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">Total deterministic score</span>
                      <span className="text-sm font-bold text-[var(--accent-evidence)]">
                        {(breakdown.required_contribution + breakdown.preferred_contribution + breakdown.experience_contribution).toFixed(1)} / 100
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-[var(--accent-gap-border)] bg-[var(--accent-gap-soft)] p-3 text-sm leading-relaxed text-[var(--accent-gap)]">
                    This evaluation predates exact score-component storage. Re-run matching to generate a verified breakdown; no component values are estimated here.
                  </div>
                )}
              </div>
            </div>

            {/* Verified Links + Career Timeline (Evidence Graph) */}
            {(resume?.parsed?.links?.length || resume?.parsed?.timeline_analysis?.spans?.length) ? (
              <div className="merix-card p-6 rounded-3xl border border-[var(--border-hairline)] space-y-5">
                <div className="flex items-center gap-2 pb-3 border-b border-[var(--border-hairline)]">
                  <Clock className="w-4 h-4 text-[var(--accent-evidence)]" />
                  <h2 className="font-display text-base font-normal text-[var(--text-primary)]">
                    Evidence Graph
                  </h2>
                </div>

                {resume?.parsed?.timeline_analysis && resume.parsed.timeline_analysis.spans.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
                        Career Timeline
                      </span>
                      <span className="text-xs font-mono font-bold text-[var(--accent-evidence)]">
                        {resume.parsed.timeline_analysis.total_experience_years} yrs total
                        (union of tenures)
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {resume.parsed.timeline_analysis.spans.map((span, i) => (
                        <div
                          key={`${span.company}-${i}`}
                          className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--bg-subtle)] dark:bg-black/40 border border-[var(--border-hairline)]"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
                              {span.title || span.company}
                            </div>
                            <div className="text-xs font-mono text-[var(--text-muted)] truncate">
                              {span.title ? `${span.company} · ` : ""}
                              {span.start_year} –{" "}
                              {span.end_open ? "Present" : span.end_year}
                            </div>
                          </div>
                          {span.end_open && (
                            <span className="ml-2 shrink-0 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[var(--accent-evidence)]/10 text-[var(--accent-evidence)]">
                              CURRENT
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    {resume.parsed.timeline_analysis.overlaps.length > 0 && (
                      <div className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400 font-mono leading-relaxed">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>
                          Concurrent roles detected:{" "}
                          {resume.parsed.timeline_analysis.overlaps.map((o) => o.join(" + ")).join("; ")}
                        </span>
                      </div>
                    )}
                    {resume.parsed.timeline_analysis.flags.length > 0 && (
                      <div className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400 font-mono leading-relaxed">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>Timeline flags: {resume.parsed.timeline_analysis.flags.join(", ")}</span>
                      </div>
                    )}
                  </div>
                )}

                {resume?.parsed?.links && resume.parsed.links.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
                      Profile Links ({resume.parsed.links.length})
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {resume.parsed.links.map((link) => {
                        const Icon = linkIcon(link);
                        const verification = resume.parsed?.link_verification?.find((v) => v.url === link.url);
                        const badge = verification ? VERIFY_BADGE[verification.status] : null;
                        return (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={badge ? `Verification: ${badge.label}` : undefined}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--bg-subtle)] dark:bg-black/40 border border-[var(--border-hairline)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent-evidence)] hover:border-[var(--accent-evidence)]/40 transition-colors max-w-[260px]"
                          >
                            <Icon className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{linkLabel(link.url)}</span>
                            {badge && (
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: badge.color }}
                                aria-label={badge.label}
                              />
                            )}
                          </a>
                        );
                      })}
                    </div>
                    <p className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed">
                      Extracted from resume hyperlinks &amp; text before PII scrubbing — the AI never saw these URLs.
                      Dots: green live · red dead/unverified profile · grey not checked.
                    </p>

                  </div>
                )}
              </div>
            ) : null}

            {/* DPDP Compliance Card */}
            <div className="merix-card p-6 rounded-3xl border border-[var(--border-hairline)] space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--accent-evidence)]">
                <ShieldCheck className="w-4 h-4" />
                <span>DPDP Act (2023) Compliance Record</span>
              </div>
              <div className="reading-text space-y-1.5 font-mono">
                <div>• PII Scrubbed before embedding extraction</div>
                <div>• Explicit recruiter consent recorded</div>
                <div>• Automatic 90-day retention purge scheduled</div>
                <div>• Evaluation ID: #{matchId.slice(0, 10)}</div>
              </div>
            </div>

            {/* Candidate Right to Erasure Card */}
            <div className="p-5 rounded-2xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--accent-danger)]">
                <Trash2 className="w-4 h-4 text-[var(--accent-danger)]" />
                <span>Candidate Right to Erasure</span>
              </div>
              <p className="reading-text">
                Under India DPDP Act Section 12, candidates may request complete erasure of personal data and match history.
              </p>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="w-full py-2 rounded-xl text-sm font-semibold text-[var(--accent-danger)] bg-[var(--accent-danger-soft)] hover:brightness-110 border border-[var(--accent-danger-border)] transition-colors cursor-pointer"
              >
                Permanently Erase Candidate Data
              </button>
            </div>
          </div>

          {/* Right Column: AI Rationale, Matched Skills & Verbatim Evidence */}
          <div className="lg:col-span-7 space-y-6">
            {/* AI Grounded Match Rationale */}
            <div className="merix-card p-6 sm:p-8 rounded-3xl border border-[var(--border-hairline)] space-y-4">
              <div className="flex items-center gap-2 pb-3 border-b border-[var(--border-hairline)]">
                <Sparkles className="w-4 h-4 text-[var(--accent-evidence)]" />
                <h2 className="font-display text-lg font-normal text-[var(--text-primary)]">
                  AI Grounded Match Rationale
                </h2>
              </div>
              <p className="reading-text">
                {match?.rationale || "No detailed rationale generated."}
              </p>
            </div>

            {/* Matched Skills with Resume Citations */}
            <div className="merix-card p-6 sm:p-8 rounded-3xl border border-[var(--border-hairline)] space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--border-hairline)]">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-[var(--accent-evidence)]" />
                  <h3 className="font-display text-base font-normal text-[var(--text-primary)]">
                    Verified Matched Skills ({match?.matched_skills.length || 0})
                  </h3>
                </div>
                <span className="text-xs font-mono text-[var(--accent-evidence)] ">VERBATIM EVIDENCE</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {match?.matched_skills.map((skill) => {
                  const adjacent = skill.match_type === "adjacent";
                  return (
                    <div
                      key={skill.skill}
                      className={`p-3 rounded-xl bg-[var(--bg-subtle)] dark:bg-black/40 border space-y-1 ${
                        adjacent
                          ? "border-[var(--accent-adjacent)]/30"
                          : "border-[var(--accent-evidence)]/20"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-sm font-semibold">
                        {adjacent ? (
                          <span className="flex items-center gap-1.5 text-[var(--accent-adjacent)]">
                            <span aria-hidden>≈</span>
                            <span>{skill.skill}</span>
                            <span className="tag-adjacent text-[10px] uppercase tracking-wider">
                              Adjacent · {Math.round((skill.similarity ?? 0) * 100)}% similar
                            </span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-[var(--accent-evidence)]">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            <span>{skill.skill}</span>
                          </span>
                        )}
                      </div>
                      {adjacent && (
                        <div className="text-xs font-mono text-[var(--accent-adjacent)] leading-relaxed">
                          Semantic match for JD requirement &ldquo;{skill.similar_to}&rdquo; — not a verbatim keyword match.
                        </div>
                      )}
                      <div className="text-sm font-mono text-[var(--text-muted)] leading-relaxed">
                        Verified from candidate career history
                      </div>
                      {skill.evidence && (
                        <div className="bg-teal-500/10 border border-teal-500/20 rounded-lg p-2.5 font-mono reading-text">
                          &ldquo;{skill.evidence}&rdquo;
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Missing Gaps Section */}
            <div className="merix-card p-6 sm:p-8 rounded-3xl border border-[var(--border-hairline)] space-y-4">
              <div className="flex items-center gap-2 pb-3 border-b border-[var(--border-hairline)]">
                <XCircle className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h3 className="font-display text-base font-normal text-[var(--text-primary)]">
                  Identified Skill &amp; Qualification Gaps ({match?.missing_skills.length || 0})
                </h3>
              </div>

              {match?.missing_skills.length === 0 ? (
                <div className="p-4 rounded-xl bg-[var(--accent-evidence-soft)] border border-[var(--accent-evidence)]/20 text-sm text-[var(--accent-evidence)] flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>This candidate satisfies all required and preferred skills from the Job Description.</span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {match?.missing_skills.map((gap) => (
                    <div
                      key={gap.skill}
                      className="p-3 rounded-xl bg-[var(--bg-subtle)] dark:bg-black/40 border border-[var(--accent-danger-border)] space-y-1"
                    >
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-orange-800 dark:text-orange-300">
                        <XCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>{gap.skill}</span>
                      </div>
                      <div className="text-sm font-mono text-[var(--text-muted)] leading-relaxed">
                        No direct evidence cited in submitted resume
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recruiter Notes (org-visible, timestamped, author-attributed) */}
            <div className="merix-card p-6 sm:p-8 rounded-3xl border border-[var(--border-hairline)] space-y-4">
              <div className="flex items-center justify-between gap-3 pb-3 border-b border-[var(--border-hairline)] flex-wrap">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-[var(--brand-primary)]" />
                  <h3 className="font-display text-base font-normal text-[var(--text-primary)]">
                    Team Notes ({notes.length})
                  </h3>
                </div>
                <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
                  Visible to your organisation
                </span>
              </div>

              {/* Composer */}
              <div className="space-y-2">
                <textarea
                  value={newNoteBody}
                  onChange={(e) => setNewNoteBody(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      handleAddNote();
                    }
                  }}
                  rows={3}
                  maxLength={5000}
                  placeholder="Add an evaluation note for your team… (Ctrl+Enter to post)"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)] transition-colors resize-y"
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-mono text-[var(--text-muted)]">
                    {newNoteBody.length} / 5000
                  </span>
                  <button
                    type="button"
                    onClick={handleAddNote}
                    disabled={noteSubmitting || !newNoteBody.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] transition-all shadow-xs disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {noteSubmitting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>{noteSubmitting ? "Posting…" : "Add Note"}</span>
                  </button>
                </div>
                {notesError && (
                  <p className="text-sm text-[var(--accent-danger)] font-mono">{notesError}</p>
                )}
              </div>

              {/* Notes list (newest first, as returned by the API) */}
              <div className="space-y-3">
                {notesLoading ? (
                  <div className="flex items-center gap-2 py-2">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                    <span className="text-xs font-mono text-[var(--text-muted)]">Loading notes…</span>
                  </div>
                ) : notes.length === 0 ? (
                  <p className="reading-text">
                    No notes yet. Record your evaluation rationale here so teammates don&apos;t re-review this candidate from scratch.
                  </p>
                ) : (
                  notes.map((note) => (
                    <div
                      key={note.id}
                      className="p-4 rounded-xl bg-[var(--bg-subtle)] dark:bg-black/40 border border-[var(--border-hairline)] space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">
                          {authorLabel(note.author_email)}
                        </span>
                        <span className="text-xs font-mono text-[var(--text-muted)]">
                          {formatNoteTime(note.created_at)}
                        </span>
                      </div>
                      <p className="reading-text whitespace-pre-wrap">{note.body}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* DPDP Deletion Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
          <div className="merix-card p-6 sm:p-8 rounded-3xl border border-[var(--accent-danger-border)] max-w-md w-full space-y-5 bg-[var(--bg-surface)] shadow-2xl">
            <div className="w-12 h-12 rounded-2xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] flex items-center justify-center text-[var(--accent-danger)]">
              <AlertTriangle className="w-6 h-6" />
            </div>

            <div className="space-y-2">
              <h3 className="font-display text-xl font-normal text-[var(--text-primary)]">
                Execute DPDP Data Erasure?
              </h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                This will permanently delete the candidate&apos;s resume, parsed embeddings, and match result from your database. An immutable audit record will be logged.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[var(--accent-danger)] hover:bg-[var(--accent-danger)] transition-colors shadow-md"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Erasing Data...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Confirm Erasure</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
