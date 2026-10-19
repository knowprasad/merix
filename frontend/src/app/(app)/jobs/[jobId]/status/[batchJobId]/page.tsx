"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { BatchJob, Job } from "@/lib/types";
import { DPDPBadge } from "@/components/dpdp-badge";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";

export default function BatchJobStatusPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = String(params.jobId);
  const batchJobId = String(params.batchJobId);
  const { isAuthenticated, loading: authLoading } = useAuth();

  const [job, setJob] = useState<Job | null>(null);
  const [batchJob, setBatchJob] = useState<BatchJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const [jobData, batchData] = await Promise.all([
        api.getJob(jobId),
        api.getBatchJobStatus(jobId, batchJobId),
      ]);
      setJob(jobData);
      setBatchJob(batchData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load job status";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [jobId, batchJobId]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/login");
      return;
    }

    // Deferred so the effect body performs no synchronous state update
    // (react-hooks/set-state-in-effect); behaviour is unchanged.
    const timer = setTimeout(() => {
      if (isAuthenticated && jobId && batchJobId) {
        loadInitialData();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [authLoading, isAuthenticated, jobId, batchJobId, router, loadInitialData]);

  // Polling loop
  useEffect(() => {
    if (!isAuthenticated || !batchJobId || !jobId) return;

    const interval = setInterval(async () => {
      try {
        const latest = await api.getBatchJobStatus(jobId, batchJobId);
        setBatchJob(latest);

        if (latest.status === "completed") {
          // Navigate straight to the ranked shortlist — the old 3-second
          // artificial countdown added perceived latency to every match run.
          clearInterval(interval);
          router.push(`/jobs/${jobId}/results`);
        } else if (latest.status === "failed") {
          clearInterval(interval);
        }
      } catch (err: unknown) {
        console.error("Polling error:", err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [isAuthenticated, batchJobId, jobId, router]);


  if (authLoading || (loading && !batchJob)) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent-evidence)] mb-3" />
        <span className="text-sm text-[var(--text-muted)] font-mono">Connecting to Evaluation Pipeline...</span>
      </div>
    );
  }

  const total = batchJob?.total_resumes || 0;
  const completed = batchJob?.completed_resumes || 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const isFinished = batchJob?.status === "completed";
  const isFailed = batchJob?.status === "failed";
  const batchResults = batchJob?.batch_results || [];
  const failedCount = batchResults.filter((r) => r.status === "failed").length;

  return (
    <div className="min-h-screen pb-16">

      <main className="max-w-4xl mx-auto px-4 sm:px-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center pb-4 border-b border-[var(--border-hairline)]">
          <div>
            <div className="text-xs font-mono text-[var(--accent-evidence)]  uppercase tracking-wider font-semibold">
              EVALUATION PIPELINE STATUS
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-normal text-[var(--text-primary)]">
              {job?.title || "Batch Processing"}
            </h1>
          </div>
          <DPDPBadge variant="row" />
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] text-[var(--accent-danger)] text-sm flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-[var(--accent-danger)] shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Backend-reported failure reason (e.g. all resumes failed processing) */}
        {isFailed && batchJob?.error_message && (
          <div className="p-3.5 rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] text-[var(--accent-danger)] text-sm flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-[var(--accent-danger)] shrink-0" />
            <span>{batchJob.error_message}</span>
          </div>
        )}

        {/* Main Status & Progress Panel */}
        <div className="merix-card p-6 sm:p-8 rounded-3xl border border-[var(--border-hairline)] space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4 border-b border-[var(--border-hairline)]">
            <div className="flex items-center gap-3">
              {isFinished ? (
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-evidence-soft)] border border-[var(--accent-evidence-border)] flex items-center justify-center text-[var(--accent-evidence)]">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
              ) : isFailed ? (
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] flex items-center justify-center text-[var(--accent-danger)]">
                  <AlertCircle className="w-6 h-6" />
                </div>
              ) : (
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-evidence-soft)] border border-[var(--accent-evidence)]/25 flex items-center justify-center text-[var(--accent-evidence)]">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-xl font-normal text-[var(--text-primary)]">
                    {isFinished
                      ? "Batch Evaluation Completed"
                      : isFailed
                      ? "Batch Evaluation Failed"
                      : "Processing Candidates Against JD"}
                  </h2>
                </div>
                <div className="text-sm text-[var(--text-muted)] font-mono mt-0.5">
                  Batch ID: #{batchJobId.slice(0, 8)} • Status: {batchJob?.status.toUpperCase()}
                </div>
              </div>
            </div>

            {isFinished && (
              <Link
                href={`/jobs/${jobId}/results`}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl font-semibold text-sm text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] transition-all shadow-md active:scale-[0.98]"
              >
                <span>View Ranked Shortlist</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            )}
          </div>

          {/* Progress Bar & Percentage */}
          <div className="space-y-3">
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-mono uppercase tracking-wider text-[var(--text-secondary)]">
                Extraction &amp; Deterministic Scoring Progress
              </span>
              <span className="font-mono text-2xl font-bold text-[var(--accent-evidence)] ">
                {percent}%
              </span>
            </div>

            <div className="w-full bg-[var(--bg-subtle)] h-3 rounded-full overflow-hidden p-0.5 border border-[var(--border-hairline)]">
              <div
                className="bg-gradient-to-r from-[var(--accent-evidence)] to-[var(--accent-gap)] h-full rounded-full transition-all duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>

            <div className="flex justify-between text-sm font-mono text-[var(--text-muted)]">
              <span>{completed} of {total} candidate resumes processed</span>
              {isFinished && <span className="text-[var(--accent-evidence)]  font-semibold">Opening ranked shortlist…</span>}
            </div>
          </div>

          {/* Partial Failure Notice */}
          {failedCount > 0 && (
            <div className="p-3.5 rounded-xl bg-[var(--accent-gap-soft)] border border-[var(--accent-gap-border)] text-[var(--accent-gap)] text-sm flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                {failedCount} resume(s) could not be parsed (corrupt PDF or encrypted). The remaining {completed - failedCount} resumes were evaluated successfully.
              </span>
            </div>
          )}

          {/* Itemized Candidate Ingestion Results Table */}
          {batchResults.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="text-sm font-mono uppercase tracking-wider text-[var(--text-muted)]">
                Processed Candidate Stream
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {batchResults.map((res, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-xl bg-[var(--bg-subtle)] dark:bg-black/40 border border-[var(--border-hairline)] dark:border-white/5 flex items-center justify-between text-sm font-mono"
                  >
                    <div className="flex items-center gap-2.5 truncate">
                      {res.status === "completed" ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-evidence)] shrink-0" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 text-[var(--accent-gap)] shrink-0" />
                      )}
                      <span className="text-[var(--text-primary)] truncate font-medium">
                        {res.candidate_name || `Resume #${i + 1}`}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      {res.status === "completed" && res.score !== undefined && (
                        <span
                          className={`px-2 py-0.5 rounded font-bold text-sm border ${
                            res.score >= 80
                              ? "bg-[var(--accent-evidence-soft)] text-[var(--accent-evidence)] border-[var(--accent-evidence-border)]"
                              : res.score >= 60
                              ? "bg-[var(--brand-soft)] text-[var(--brand-primary)] border-[var(--brand-border)]"
                              : "bg-[var(--accent-gap-soft)] text-[var(--accent-gap)] border-[var(--accent-gap-border)]"
                          }`}
                        >
                          Score: {Math.round(res.score)}/100
                        </span>
                      )}
                      {res.status === "failed" && (
                        <span className="text-xs text-[var(--accent-gap)] truncate max-w-[160px]">
                          {res.error || "Parsing failed"}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
