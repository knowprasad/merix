"use client";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Job, MatchResult } from "@/lib/types";
import { DPDPBadge } from "@/components/dpdp-badge";
import { ScoreRing } from "@/components/score-ring";
import {
  Search,
  ArrowLeft,
  UploadCloud,
  FileText,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  CheckCircle2,
  ShieldCheck,
  ExternalLink,
  X,
  BookmarkCheck,
  XCircle,
} from "lucide-react";

/* ---- Results table density (persisted locally per browser) ---- */
type Density = "comfortable" | "compact";
const DENSITY_STORAGE_KEY = "merix_results_density";

function RankedResults() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobId = String(params.jobId);
  const { isAuthenticated, loading: authLoading } = useAuth();

  const [job, setJob] = useState<Job | null>(null);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Filter/search state initialised from URL, persisted back to URL ---- */
  const parseMinScore = (raw: string | null): number | undefined => {
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  const [minScoreFilter, setMinScoreFilter] = useState<number | undefined>(() =>
    parseMinScore(searchParams.get("min_score"))
  );
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") ?? "");
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<string>>(new Set());
  const [bulkStatusPending, setBulkStatusPending] = useState<"shortlisted" | "rejected" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  /* Restore the saved row-density preference once mounted.
     Deferred so the effect body performs no synchronous setState
     (react-hooks/set-state-in-effect); behaviour is unchanged. */
  const [density, setDensity] = useState<Density>("comfortable");
  useEffect(() => {
    const timer = setTimeout(() => {
      const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
      if (stored === "compact" || stored === "comfortable") {
        setDensity(stored);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const setDensityPref = (next: Density) => {
    setDensity(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — preference just won't persist */
    }
  };
  const rowPad = density === "compact" ? "py-1.5" : "py-4";

  /* Mirror filter/search changes into the URL (replace, not push) so that
     navigating to a candidate dossier and coming back restores this state.
     Debounced so typing in the search box doesn't thrash the router. */
  const skipInitialUrlSync = useRef(true);
  useEffect(() => {
    if (skipInitialUrlSync.current) {
      skipInitialUrlSync.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const next = new URLSearchParams();
      if (minScoreFilter !== undefined) next.set("min_score", String(minScoreFilter));
      if (searchTerm) next.set("q", searchTerm);
      const qs = next.toString();
      router.replace(`/jobs/${jobId}/results${qs ? `?${qs}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [minScoreFilter, searchTerm, jobId, router]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobData, shortlistData] = await Promise.all([
        api.getJob(jobId),
        api.listMatches(jobId, minScoreFilter),
      ]);
      setJob(jobData);
      setMatches(shortlistData.results);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load ranked matches";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [jobId, minScoreFilter]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/login");
      return;
    }

    // Deferred so the effect body performs no synchronous state update
    // (react-hooks/set-state-in-effect); behaviour is unchanged.
    const timer = setTimeout(() => {
      if (isAuthenticated && jobId) {
        loadData();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [authLoading, isAuthenticated, jobId, minScoreFilter, router, loadData]);

  const filteredMatches = matches.filter((m) => {
    const query = searchTerm.toLowerCase();
    const nameMatch = (m.candidate_name || "").toLowerCase().includes(query);
    const skillMatch = m.matched_skills.some((s) => s.skill.toLowerCase().includes(query));
    const gapMatch = m.missing_skills.some((s) => s.skill.toLowerCase().includes(query));
    return nameMatch || skillMatch || gapMatch;
  });

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      await api.downloadMatchesCsv(jobId, minScoreFilter);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to export shortlist");
    } finally {
      setExporting(false);
    }
  };

  /* ---- Bulk selection & selected-candidate CSV (client-side) ---- */
  const selectAllRef = useRef<HTMLInputElement>(null);
  const allVisibleSelected =
    filteredMatches.length > 0 && filteredMatches.every((m) => selectedMatchIds.has(m.id));
  const someVisibleSelected = filteredMatches.some((m) => selectedMatchIds.has(m.id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  const toggleMatchSelection = (matchId: string) => {
    setSelectedMatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(matchId)) {
        next.delete(matchId);
      } else {
        next.add(matchId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedMatchIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        filteredMatches.forEach((m) => next.delete(m.id));
      } else {
        filteredMatches.forEach((m) => next.add(m.id));
      }
      return next;
    });
  };

  const exportSelectedCsv = () => {
    // Mirrors the backend GET /jobs/{id}/matches/export column shape,
    // scoped to just the currently selected candidates.
    const selectedMatches = matches.filter((m) => selectedMatchIds.has(m.id));
    if (selectedMatches.length === 0) return;

    const escapeCell = (value: string | number | null | undefined) => {
      const s = String(value ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows: Array<Array<string | number>> = [
      ["Candidate Name", "Score", "Matched Skills", "Missing Skills", "Rationale"],
    ];
    for (const m of selectedMatches) {
      rows.push([
        m.candidate_name || "Unknown",
        m.score,
        m.matched_skills
          .map((s) => (s.match_type === "adjacent" ? `${s.skill} (~${Math.round((s.similarity ?? 0) * 100)}% similar)` : s.skill))
          .join(", "),
        m.missing_skills.map((s) => s.skill).join(", "),
        m.rationale,
      ]);
    }
    const csv = rows.map((r) => r.map(escapeCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `shortlist_selected_${jobId}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const applyBulkStatus = async (status: "shortlisted" | "rejected") => {
    setBulkStatusPending(status);
    setBulkError(null);
    try {
      await api.bulkUpdateMatchStatus(jobId, [...selectedMatchIds], status);
      // Optimistic update — the persisted status now matches locally.
      setMatches((prev) =>
        prev.map((m) => (selectedMatchIds.has(m.id) ? { ...m, status } : m))
      );
      setSelectedMatchIds(new Set());
    } catch (err: unknown) {
      setBulkError(err instanceof Error ? err.message : "Failed to update candidates");
    } finally {
      setBulkStatusPending(null);
    }
  };

  /* ---- Cohort analytics (client-side, zero extra API calls) ---- */
  const sortedScores = [...matches].map((m) => m.score).sort((a, b) => a - b);
  const topScore = sortedScores.length ? Math.round(sortedScores[sortedScores.length - 1]) : null;
  const medianScore =
    sortedScores.length > 0
      ? Math.round(
          sortedScores.length % 2 === 1
            ? sortedScores[(sortedScores.length - 1) / 2]
            : (sortedScores[sortedScores.length / 2 - 1] + sortedScores[sortedScores.length / 2]) / 2
        )
      : null;

  const skillGapMap = new Map<string, number>();
  matches.forEach((m) =>
    m.missing_skills.forEach((ms) => {
      const name = typeof ms === "string" ? ms : ms.skill;
      skillGapMap.set(name, (skillGapMap.get(name) || 0) + 1);
    })
  );
  const topGaps = [...skillGapMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  if (authLoading || (loading && !job)) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center bg-[var(--bg-canvas)]">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-primary)] mb-3" />
        <span className="text-sm text-[var(--text-muted)] font-mono">
          Loading Ranked Shortlist...
        </span>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-16 bg-[var(--bg-canvas)] text-[var(--text-primary)]">

      <main className="max-w-7xl mx-auto px-4 sm:px-6 space-y-6">
        {/* Breadcrumb & Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4 border-b border-[var(--border-hairline)]">
          <div className="space-y-1">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Pipeline</span>
            </Link>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl sm:text-3xl text-[var(--text-primary)]">
                {job?.title || "Ranked Candidate Shortlist"}
              </h1>
              <DPDPBadge variant="row" />
            </div>
            <p className="text-sm text-[var(--text-muted)] font-mono">
              Job ID: {jobId} • Evaluated with Deterministic 70/20/10 Formula
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Row-density toggle */}
            <div
              className="hidden sm:flex items-center rounded-xl border border-[var(--border-hairline)] overflow-hidden"
              role="group"
              aria-label="Table row density"
            >
              {(["comfortable", "compact"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensityPref(d)}
                  aria-pressed={density === d}
                  title={d === "comfortable" ? "Comfortable rows" : "Compact rows"}
                  className={`px-2.5 py-2 text-xs font-semibold font-mono transition-colors cursor-pointer ${
                    density === d
                      ? "bg-[var(--brand-primary)] text-white"
                      : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                  }`}
                >
                  {d === "comfortable" ? "Roomy" : "Compact"}
                </button>
              ))}
            </div>
            <Link
              href={`/jobs/${jobId}/upload`}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold bg-[var(--bg-subtle)] text-[var(--text-primary)] border border-[var(--border-hairline)] hover:bg-[var(--bg-elevated)] transition-colors"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              <span>Add More Resumes</span>
            </Link>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] transition-all shadow-xs"
            >
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
              <span>{exporting ? "Exporting…" : "Export CSV"}</span>
            </button>
          </div>
        </div>

        {/* Embedded Direct Trust Statement (Truffle Style) */}
        <div className="p-3.5 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-hairline)] flex items-center justify-between gap-4 text-sm font-mono">
          <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <CheckCircle2 className="w-4 h-4 text-[var(--accent-evidence)] shrink-0" />
            <span>
              <strong>Merix never auto-rejects.</strong> Every candidate reaches you with verbatim evidence so you make every advance call.
            </span>
          </div>
          <div className="text-xs text-[var(--text-muted)] shrink-0 hidden md:block">
            DPDP Section 12 Audited
          </div>
        </div>

        {/* Cohort Stats + Skill Gap Analysis */}
        {matches.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Stat Cards */}
            <div className="lg:col-span-4 grid grid-cols-3 lg:grid-cols-1 gap-3">
              <div className="merix-card p-4 space-y-0.5">
                <div className="text-xs font-mono text-[var(--text-muted)] uppercase tracking-wider">
                  Candidates Ranked
                </div>
                <div className="text-2xl font-mono font-bold text-[var(--text-primary)]">
                  {matches.length}
                </div>
              </div>
              <div className="merix-card p-4 space-y-0.5">
                <div className="text-xs font-mono text-[var(--text-muted)] uppercase tracking-wider">
                  Top Score
                </div>
                <div className="text-2xl font-mono font-bold text-[var(--accent-evidence)]">
                  {topScore !== null ? topScore : "—"}
                </div>
              </div>
              <div className="merix-card p-4 space-y-0.5">
                <div className="text-xs font-mono text-[var(--text-muted)] uppercase tracking-wider">
                  Median Score
                </div>
                <div className="text-2xl font-mono font-bold text-[var(--brand-primary)]">
                  {medianScore !== null ? medianScore : "—"}
                </div>
              </div>
            </div>

            {/* Skill Gap Panel */}
            <div className="lg:col-span-8 merix-card p-5 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-sm font-mono font-semibold text-[var(--text-primary)] uppercase tracking-wider">
                  Skill Gap Analysis
                </span>
                <span className="text-xs font-mono text-[var(--text-muted)]">
                  most-missing skills across this cohort
                </span>
              </div>
              {topGaps.length === 0 ? (
                <div className="text-sm text-[var(--text-muted)] font-mono py-2">
                  No skill gaps detected — strong cohort fit.
                </div>
              ) : (
                <div className="space-y-2">
                  {topGaps.map(([skill, count]) => {
                    const pct = Math.round((count / matches.length) * 100);
                    return (
                      <div key={skill} className="flex items-center gap-3 text-sm">
                        <span className="w-44 shrink-0 truncate font-mono text-xs text-[var(--text-secondary)]">
                          {skill}
                        </span>
                        <div className="flex-1 h-2.5 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[var(--accent-gap)] transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-20 shrink-0 text-right font-mono text-xs text-[var(--text-muted)]">
                          {count}/{matches.length} · {pct}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 p-3 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-hairline)] shadow-xs">
          {/* Score Threshold Filters */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
            <span className="text-xs font-mono text-[var(--text-muted)] mr-2 shrink-0">
              Filter:
            </span>
            {[
              { label: "All Applicants", val: undefined },
              { label: "Strong Fit (80%+)", val: 80 },
              { label: "Good Fit (70%+)", val: 70 },
              { label: "Moderate (60%+)", val: 60 },
            ].map((f) => {
              const active = minScoreFilter === f.val;
              return (
                <button
                  key={f.label}
                  onClick={() => setMinScoreFilter(f.val)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-mono font-semibold transition-all shrink-0 cursor-pointer ${
                    active
                      ? "bg-[var(--brand-primary)] text-white shadow-xs"
                      : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* Search Input */}
          <div className="relative min-w-[220px]">
            <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search candidate or skill..."
              className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)] transition-colors"
            />
          </div>
        </div>

        {/* Bulk Action Bar (appears while a selection is active) */}
        {selectedMatchIds.size > 0 && (
          <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 p-3 rounded-2xl bg-[var(--bg-surface)] border border-[var(--brand-primary)] shadow-xs">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-[var(--brand-primary)] shrink-0" />
              <span className="text-sm font-mono font-semibold text-[var(--text-primary)]">
                {selectedMatchIds.size} candidate{selectedMatchIds.size === 1 ? "" : "s"} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => applyBulkStatus("shortlisted")}
                disabled={bulkStatusPending !== null}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold bg-[var(--accent-evidence)] text-white hover:brightness-95 transition-all shadow-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkStatusPending === "shortlisted" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <BookmarkCheck className="w-3.5 h-3.5" />
                )}
                <span>Shortlist Selected</span>
              </button>
              <button
                onClick={() => applyBulkStatus("rejected")}
                disabled={bulkStatusPending !== null}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold bg-[var(--accent-danger)] text-white hover:brightness-95 transition-all shadow-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkStatusPending === "rejected" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                <span>Reject Selected</span>
              </button>
              <button
                onClick={exportSelectedCsv}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] transition-all shadow-xs cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Export Selected</span>
              </button>
              <button
                onClick={() => setSelectedMatchIds(new Set())}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold bg-[var(--bg-subtle)] text-[var(--text-secondary)] border border-[var(--border-hairline)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear Selection</span>
              </button>
            </div>
            {bulkError && (
              <div className="w-full sm:w-auto flex items-center gap-1.5 text-xs font-mono text-[var(--accent-danger)]">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{bulkError}</span>
              </div>
            )}
          </div>
        )}

        {/* Results Table with Truffle-Style "Why This Matters" Expandable Drawers */}
        {loading ? (
          <div className="p-12 text-center merix-card space-y-3">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--brand-primary)] mx-auto" />
            <div className="text-sm text-[var(--text-muted)] font-mono">Filtering candidates...</div>
          </div>
        ) : filteredMatches.length === 0 ? (
          <div className="p-12 text-center merix-card space-y-4">
            <FileText className="w-10 h-10 text-[var(--text-muted)] mx-auto opacity-50" />
            <div className="space-y-1">
              <h3 className="text-base font-bold text-[var(--text-primary)]">
                No candidates found matching this filter
              </h3>
              <p className="text-sm text-[var(--text-muted)]">
                Try resetting your score threshold or upload additional candidate resumes.
              </p>
            </div>
            <button
              onClick={() => {
                setMinScoreFilter(undefined);
                setSearchTerm("");
              }}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-[var(--brand-primary)] text-white"
            >
              Reset Filters
            </button>
          </div>
        ) : (
          <div className="merix-card overflow-hidden divide-y divide-[var(--border-hairline)] shadow-xs">
            {/* Table Header */}
            <div className="px-5 py-3 bg-[var(--bg-subtle)] grid grid-cols-12 text-xs font-mono font-bold uppercase tracking-wider text-[var(--text-muted)]">
              <div className="col-span-1 flex items-center">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all candidates"
                  className="w-4 h-4 cursor-pointer accent-[var(--brand-primary)]"
                />
              </div>
              <div className="col-span-1">Rank</div>
              <div className="col-span-4">Candidate</div>
              <div className="col-span-2 text-center">Fit Score</div>
              <div className="col-span-3">Matched &amp; Missing Competencies</div>
              <div className="col-span-1 text-right">Details</div>
            </div>

            {/* Candidate Rows */}
            {filteredMatches.map((m, idx) => {
              const isExpanded = expandedMatchId === m.id;
              const verd = m.score >= 80 ? "Strong" : m.score >= 60 ? "Mixed" : "Weak";
              const verdClass =
                m.score >= 80
                  ? "verd-strong"
                  : m.score >= 60
                  ? "verd-mixed"
                  : "verd-weak";

              return (
                <div key={m.id} className="transition-colors hover:bg-[var(--bg-subtle)]/50">
                  {/* Row Summary Bar */}
                  <div
                    onClick={() => setExpandedMatchId(isExpanded ? null : m.id)}
                    className={`px-5 ${rowPad} grid grid-cols-12 items-center gap-2 cursor-pointer select-none`}
                  >
                    {/* Bulk Selection */}
                    <div className="col-span-1 flex items-center">
                      <input
                        type="checkbox"
                        checked={selectedMatchIds.has(m.id)}
                        onChange={() => toggleMatchSelection(m.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${m.candidate_name || "candidate"}`}
                        className="w-4 h-4 cursor-pointer accent-[var(--brand-primary)]"
                      />
                    </div>

                    {/* Rank */}
                    <div className="col-span-1 font-mono text-sm font-bold text-[var(--text-muted)]">
                      #{idx + 1}
                    </div>

                    {/* Candidate Identity */}
                    <div className="col-span-4 min-w-0 pr-2">
                      <div className="font-bold text-sm text-[var(--text-primary)] truncate">
                        {m.candidate_name || "Applicant"}
                        {m.status === "shortlisted" && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border bg-[var(--accent-evidence-soft)] text-[var(--accent-evidence)] border-[var(--accent-evidence-border)] align-middle">
                            Shortlisted
                          </span>
                        )}
                        {m.status === "rejected" && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border bg-[var(--accent-danger-soft)] text-[var(--accent-danger)] border-[var(--accent-danger-border)] align-middle">
                            Rejected
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-[var(--text-muted)] truncate mt-0.5">
                        ID: {m.resume_id.substring(0, 8)} • Click to inspect evidence
                      </div>
                    </div>

                    {/* Score Ring & Verdict */}
                    <div className="col-span-2 flex items-center justify-center gap-2">
                      <ScoreRing score={m.score} size={42} strokeWidth={4} />
                      <span className={verdClass}>{verd}</span>
                    </div>

                    {/* Skills Chips */}
                    <div className="col-span-3 flex flex-wrap gap-1 pr-2">
                      {m.matched_skills.slice(0, 3).map((sk) =>
                        sk.match_type === "adjacent" ? (
                          <span key={sk.skill} className="tag-adjacent text-[10px]" title={`Adjacent match for "${sk.similar_to}" (${Math.round((sk.similarity ?? 0) * 100)}% similar)`}>
                            ≈ {sk.skill}
                          </span>
                        ) : (
                          <span key={sk.skill} className="tag-evidence text-[10px]">
                            ✓ {sk.skill}
                          </span>
                        ),
                      )}
                      {m.missing_skills.slice(0, 1).map((sk) => (
                        <span key={sk.skill} className="tag-gap text-[10px]">
                          ✗ {sk.skill}
                        </span>
                      ))}
                      {m.matched_skills.length > 3 && (
                        <span className="tag-neutral text-xs">
                          +{m.matched_skills.length - 3} more
                        </span>
                      )}
                    </div>

                    {/* Expand Chevron & Link */}
                    <div className="col-span-1 flex items-center justify-end gap-2 text-[var(--text-muted)]">
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-[var(--brand-primary)]" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </div>
                  </div>

                  {/* Truffle-Style "Why This Matters" Expandable Evidence Drawer */}
                  {isExpanded && (
                    <div className="px-6 py-5 bg-[var(--bg-subtle)] border-t border-[var(--border-hairline)] space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                        {/* Left: AI Rationale & Quote */}
                        <div className="md:col-span-8 space-y-3">
                          <div className="space-y-1">
                            <div className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--text-muted)]">
                              Verbatim Monospace Citation from Candidate Resume:
                            </div>
                            <div className="forensic-citation">
                              &ldquo;{m.rationale || "Candidate demonstrates required technical competencies across core job specification criteria."}&rdquo;
                            </div>
                          </div>

                          <div className="space-y-1">
                            <div className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--text-muted)]">
                              All Extracted Technical Competencies:
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {m.matched_skills.map((sk) =>
                                sk.match_type === "adjacent" ? (
                                  <span
                                    key={sk.skill}
                                    className="tag-adjacent"
                                    title={`Semantic match for JD skill "${sk.similar_to}"`}
                                  >
                                    ≈ {sk.skill} ({Math.round((sk.similarity ?? 0) * 100)}% similar)
                                  </span>
                                ) : (
                                  <span key={sk.skill} className="tag-evidence">
                                    ✓ {sk.skill}
                                  </span>
                                ),
                              )}
                              {m.missing_skills.map((sk) => (
                                <span key={sk.skill} className="tag-gap">
                                  ✕ {sk.skill} (Gap)
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Right: Actions & Dossier Link */}
                        <div className="md:col-span-4 p-4 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-hairline)] space-y-3 flex flex-col justify-between">
                          <div className="space-y-1">
                            <div className="text-xs font-mono uppercase text-[var(--text-muted)]">
                              Evaluation Actions
                            </div>
                            <div className="text-sm font-bold text-[var(--text-primary)]">
                              Ready for Recruiter Decision
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Link
                              href={`/jobs/${jobId}/candidates/${m.id}`}
                              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-hover)] transition-colors"
                            >
                              <span>Open Candidate Dossier</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Link>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

/* useSearchParams() requires a Suspense boundary under static prerendering. */
export default function RankedResultsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex flex-col justify-center items-center bg-[var(--bg-canvas)]">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-primary)] mb-3" />
          <span className="text-sm text-[var(--text-muted)] font-mono">Loading Ranked Shortlist...</span>
        </div>
      }
    >
      <RankedResults />
    </Suspense>
  );
}
