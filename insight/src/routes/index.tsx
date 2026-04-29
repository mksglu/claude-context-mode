import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type AnalyticsData, type CategoryAnalyticsData } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Brain, TrendingUp, AlertTriangle, CheckCircle,
  Zap, FileCode, GitBranch, Clock, Shield, Activity, Cpu,
  Lightbulb, BookOpen, Wrench, Users, MessageSquare, Search,
  FolderOpen, Code,
} from "lucide-react";

export const Route = createFileRoute("/")({ component: Dashboard });

const COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

// ── Insight types ──
interface Insight {
  icon: React.ReactNode;
  severity: "positive" | "warning" | "critical" | "neutral";
  metric: string;
  evidence: string;
  action: string;
  roi: string;
}

const SEV_STYLES = {
  positive: { border: "border-emerald-500/30", bg: "bg-emerald-500/5", badge: "bg-emerald-500/15 text-emerald-400", label: "Nice" },
  warning: { border: "border-amber-500/30", bg: "bg-amber-500/5", badge: "bg-amber-500/15 text-amber-400", label: "Heads up" },
  critical: { border: "border-red-500/30", bg: "bg-red-500/5", badge: "bg-red-500/15 text-red-400", label: "Fix this" },
  neutral: { border: "border-blue-500/30", bg: "bg-blue-500/5", badge: "bg-blue-500/15 text-blue-400", label: "FYI" },
};

function InsightCard({ icon, severity, metric, evidence, action, roi }: Insight) {
  const s = SEV_STYLES[severity];
  return (
    <Card className={`${s.border} ${s.bg}`}>
      <CardContent className="p-5">
      {/* Header: badge + title */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${s.badge}`}>
          {s.label}
        </span>
      </div>

      {/* Main metric - the headline */}
      <div className="flex items-center gap-2.5 mb-2">
        <div className="shrink-0">{icon}</div>
        <h4 className="text-base font-bold leading-tight">{metric}</h4>
      </div>

      {/* Evidence - short and readable */}
      <p className="text-[13px] text-muted-foreground leading-relaxed mb-4">{evidence}</p>

      {/* Action + ROI as distinct blocks */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-background/40 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">What to do</p>
          <p className="text-xs leading-relaxed">{action}</p>
        </div>
        <div className="rounded-lg bg-background/40 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Why it matters</p>
          <p className="text-xs leading-relaxed">{roi}</p>
        </div>
      </div>
      </CardContent>
    </Card>
  );
}

// ── Big number stat ──
function Stat({ label, value, sub, icon: Icon, color }: {
  label: string; value: string | number; sub: string; icon: typeof Zap; color: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</CardTitle>
        <Icon className={`h-4 w-4 ${color}`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  );
}

// ── Ratio bar ──
function RatioBar({ items }: { items: { label: string; value: number; color: string }[] }) {
  const total = items.reduce((a, b) => a + b.value, 0);
  if (total === 0) return null;
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-secondary">
        {items.map((item, i) => (
          <div key={i} className="transition-all" style={{
            width: `${Math.max(Math.round(100 * item.value / total), 2)}%`,
            background: item.color,
          }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {items.map((item, i) => (
          <span key={i} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: item.color }} />
            {item.label}: {item.value} ({Math.round(100 * item.value / total)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Mini number ──
function Mini({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold tabular-nums ${color || ""}`}>{value}</div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
    </div>
  );
}

// ── Insights engine ──
function generateInsights(d: AnalyticsData): Insight[] {
  const ins: Insight[] = [];
  const t = d.totals;

  // ── Reading more than writing
  if (t.reads + t.writes >= 5) {
    const ratio = t.readWriteRatio;
    if (ratio > 5) {
      ins.push({
        icon: <BookOpen className="h-5 w-5 text-blue-500" />, severity: "neutral",
        metric: `You read ${ratio}x more than you write`,
        evidence: `${t.reads} files read vs ${t.writes} files written. You're spending most of your AI time understanding code, not producing it.`,
        action: "Write a short plan before starting. Clarify what you want to change before reading everything.",
        roi: "Planning upfront typically reduces the number of file re-reads.",
      });
    } else if (ratio < 2 && ratio > 0) {
      ins.push({
        icon: <FileCode className="h-5 w-5 text-emerald-500" />, severity: "positive",
        metric: `Healthy balance: ${ratio}:1 read-to-write`,
        evidence: `You're reading just enough to write confidently. ${t.writes} files written with only ${t.reads} reads.`,
        action: "Keep this up — you're not over-analyzing or guessing blind.",
        roi: "This balance leads to fewer bugs on first attempt.",
      });
    }
  }

  // ── Context filling up
  if (t.totalSessions >= 3) {
    const pct = t.compactRate;
    if (pct > 60) {
      ins.push({
        icon: <Brain className="h-5 w-5 text-amber-500" />, severity: "warning",
        metric: `${pct}% of your sessions run out of context`,
        evidence: `${t.totalCompacts} times the agent had to compress your conversation. Each time, it forgets details from earlier work.`,
        action: "Start fresh sessions for new tasks instead of continuing long ones.",
        roi: `You'd recover ~${Math.round(t.totalCompacts * 3)} minutes of re-explaining lost context.`,
      });
    } else if (pct < 20 && t.totalSessions >= 5) {
      ins.push({
        icon: <CheckCircle className="h-5 w-5 text-emerald-500" />, severity: "positive",
        metric: `Only ${pct}% context overflow — you're efficient`,
        evidence: `${t.totalCompacts} compactions in ${t.totalSessions} sessions. Your tasks are well-scoped.`,
        action: "Share this pattern with your team — most developers hit 60%+.",
        roi: "Less context loss = less time re-explaining = faster completion.",
      });
    }
  }

  // ── Errors
  if (t.totalEvents >= 20) {
    const rate = t.errorRate;
    if (rate > 10) {
      ins.push({
        icon: <AlertTriangle className="h-5 w-5 text-red-500" />, severity: "critical",
        metric: `${rate}% of your tool calls fail`,
        evidence: `${t.totalErrors} errors in ${t.totalEvents} calls. That's a lot of wasted back-and-forth.`,
        action: "Check if the same error keeps repeating. Add a CLAUDE.md rule to prevent it.",
        roi: `Fixing this saves ~${Math.round(t.totalErrors * 2)} minutes of retry loops.`,
      });
    } else if (rate < 3) {
      ins.push({
        icon: <Shield className="h-5 w-5 text-emerald-500" />, severity: "positive",
        metric: `Only ${rate}% error rate — you're a power user`,
        evidence: `${t.totalErrors} errors in ${t.totalEvents} calls. Almost everything works on the first try.`,
        action: "Document your prompting style — others can learn from it.",
        roi: "Clean usage means more time building, less time debugging.",
      });
    }
  }

  // ── Parallel work
  if (t.totalSessions >= 2) {
    if (t.totalSubagents > 0 && d.subagents.bursts > 0) {
      ins.push({
        icon: <Users className="h-5 w-5 text-emerald-500" />, severity: "positive",
        metric: `You saved ~${d.subagents.timeSavedMin} min with parallel agents`,
        evidence: `${d.subagents.parallelCount} tasks ran simultaneously in ${d.subagents.bursts} bursts (up to ${d.subagents.maxConcurrent} at once).`,
        action: "Keep delegating research and exploration to subagents.",
        roi: "Parallel work is the single biggest time multiplier available to you.",
      });
    } else if (t.totalSubagents === 0 && t.totalEvents > 50) {
      ins.push({
        icon: <Users className="h-5 w-5 text-muted-foreground" />, severity: "neutral",
        metric: "Everything ran sequentially",
        evidence: `${t.totalEvents} events, zero parallel agents. You're doing one thing at a time.`,
        action: "Try subagents for research — fire 3-5 at once instead of doing them one by one.",
        roi: "One parallel burst can turn 10 minutes of research into 2 minutes.",
      });
    }
  }

  // ── Prompt efficiency
  if (t.totalPrompts >= 5 && t.totalSessions >= 2) {
    const pps = t.promptsPerSession;
    if (pps < 3) {
      ins.push({
        icon: <MessageSquare className="h-5 w-5 text-emerald-500" />, severity: "positive",
        metric: `${pps} prompts per session — clear instructions`,
        evidence: `You give the agent clear, complete instructions. It works autonomously without needing constant guidance.`,
        action: "This is the ideal. Keep writing comprehensive upfront instructions.",
        roi: "Every avoided back-and-forth saves context for actual work.",
      });
    }
  }

  // ── Mastery trend
  if (d.masteryTrend && d.masteryTrend.length >= 3) {
    const first = d.masteryTrend[0];
    const last = d.masteryTrend[d.masteryTrend.length - 1];
    if (last.error_rate < first.error_rate) {
      ins.push({
        icon: <TrendingUp className="h-5 w-5 text-emerald-500" />, severity: "positive",
        metric: "Your error rate is dropping — you're getting better",
        evidence: `Week 1: ${first.error_rate}%, Latest: ${last.error_rate}%. Consistent improvement over ${d.masteryTrend.length} weeks.`,
        action: "Keep refining your prompting patterns.",
        roi: "Lower errors = less retry time = faster completion.",
      });
    }
  }


  // ── Commit rate
  if (t.commitsPerSession > 1) {
    ins.push({
      icon: <GitBranch className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `${t.commitsPerSession} commits per session — high output`,
      evidence: `${t.totalCommits} total commits across ${t.totalSessions} sessions.`,
      action: "Maintain this shipping cadence.",
      roi: "Frequent commits reduce merge conflicts and context loss.",
    });
  }

  // ── Edit-test cycles
  if (t.totalEditTestCycles > t.totalSessions * 2) {
    ins.push({
      icon: <Activity className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `${t.totalEditTestCycles} edit-error cycles — lots of retry loops`,
      evidence: `${(t.totalEditTestCycles / t.totalSessions).toFixed(1)} cycles per session on average.`,
      action: "Write tests first, or add patterns to CLAUDE.md to prevent common errors.",
      roi: "Fewer retry loops means faster task completion.",
    });
  }

  // ── Task structure
  if (t.totalTasks > 0 && t.totalSessions >= 2) {
    ins.push({
      icon: <Wrench className="h-5 w-5 text-blue-500" />, severity: "positive",
      metric: `${(t.totalTasks / t.totalSessions).toFixed(1)} tasks per session — you plan ahead`,
      evidence: `${t.totalTasks} structured tasks across ${t.totalSessions} sessions. You break work into steps.`,
      action: "Keep using tasks — they make sessions resumable after breaks.",
      roi: "Structured sessions are easier to resume and track progress.",
    });
  }

  return ins;
}

function generateCategoryInsights(c: CategoryAnalyticsData): Insight[] {
  const ins: Insight[] = [];
  const cs = c.compositeScores;
  const ei = c.errorIntelligence;
  const del = c.delegation;
  const gov = c.governance;
  const ctx = c.contextHealth;
  const fi = c.fileIntelligence;
  const git = c.gitProductivity;
  const totalEvents = c.categories.reduce((a, b) => a + b.count, 0);

  // P1 removed — duplicate of generateInsights read:write ratio pattern

  // ── P2: High file churn ──
  if (fi.hotFiles.length > 3) {
    const top = fi.hotFiles[0];
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `${fi.hotFiles.length} hot files with repeated edits`,
      evidence: `${top.file.split('/').pop()} was touched ${top.touches} times. Possible rework loop.`,
      action: "Read the full file before editing. Add constraints to CLAUDE.md.",
      roi: `Fewer re-edits save ~${fi.hotFiles.length * 3} minutes per session.`,
    });
  }

  // ── P3: Session failed — errors + 0 commits (★★ STRONG from agentisd #5) ──
  if (ei.totalErrors > 3 && git.totalCommits === 0 && totalEvents > 50) {
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-red-500" />, severity: "critical",
      metric: `${ei.totalErrors} errors, zero commits — session effort lost`,
      evidence: `${totalEvents} events with ${ei.totalErrors} errors and no commits. All effort was lost.`,
      action: "Review the error pattern, fix root cause, break tasks into smaller deliverable chunks.",
      roi: `Recovering from failed sessions costs an additional ${Math.round(totalEvents * 0.5)} minutes.`,
    });
  }

  // ── P4: Zero commits ──
  if (git.totalCommits === 0 && totalEvents > 100) {
    ins.push({
      icon: <GitBranch className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: "No commits across all sessions",
      evidence: `${totalEvents} events recorded, zero commits. Work may not be reaching the codebase.`,
      action: "Commit incrementally — small commits are easier to review.",
      roi: "Regular commits create a safety net for rollbacks.",
    });
  }

  // ── Q1: High error resolution ──
  if (ei.totalErrors >= 5 && ei.resolutionRate > 80) {
    ins.push({
      icon: <CheckCircle className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `${ei.resolutionRate}% of errors resolved within session`,
      evidence: `${ei.resolvedErrors} of ${ei.totalErrors} errors fixed. Self-healing sessions.`,
      action: "Keep this up — self-healing sessions are the gold standard.",
      roi: "Each resolved error saves 5-10 min of next-session debugging.",
    });
  }

  // ── Q2: Retry storm (>=2 to avoid single-fluke false positive) ──
  if (ei.retryStorms >= 2) {
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-red-500" />, severity: "critical",
      metric: `${ei.retryStorms} retry storm${ei.retryStorms > 1 ? 's' : ''} detected`,
      evidence: `Sessions where the same tool was called 3+ times with similar input. The agent gets stuck in loops.`,
      action: "Stop and re-think the approach. Add error context to CLAUDE.md.",
      roi: `Breaking retry loops saves ~${ei.retryStorms * 5} minutes of wasted compute.`,
    });
  }

  // ── Q3: Persistent errors ──
  if (ei.totalErrors >= 5 && ei.resolutionRate < 30) {
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `Only ${ei.resolutionRate}% of errors get resolved`,
      evidence: `${ei.totalErrors - ei.resolvedErrors} errors left unresolved. Technical debt accumulating.`,
      action: "Address root causes — add patterns to prevent recurring errors.",
      roi: `Resolving persistent errors prevents hours of future debugging.`,
    });
  }

  // ── Q4: Slow tool bottleneck ──
  if (ei.p95LatencyMs > 15000 && ei.slowestTool) {
    ins.push({
      icon: <Clock className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `${ei.slowestTool} averaging ${Math.round(ei.avgLatencyMs / 1000)}s — bottleneck`,
      evidence: `P95 latency: ${Math.round(ei.p95LatencyMs / 1000)}s. ${ei.latencyByTool.length} tools tracked for latency.`,
      action: "Check if tool can be replaced or if input can be simplified.",
      roi: `Fixing bottleneck saves ~${Math.round(ei.latencyByTool.reduce((a, t) => a + t.count, 0) * ei.avgLatencyMs / 60000)} minutes total.`,
    });
  }

  // ── S1: Power delegator ──
  if (del.launched > 10 && del.completionRate > 70) {
    ins.push({
      icon: <Users className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `${del.launched} agents delegated — ${del.completionRate}% completion`,
      evidence: `${del.parallelBursts} parallel bursts, up to ${del.maxConcurrent} concurrent. ~${del.timeSavedMin} min saved.`,
      action: "Excellent use of parallelism. Share this pattern with the team.",
      roi: `Parallel delegation saved ~${del.timeSavedMin} minutes.`,
    });
  }

  // ── S2: No delegation ──
  if (del.launched === 0 && totalEvents > 50) {
    ins.push({
      icon: <Users className="h-5 w-5 text-muted-foreground" />, severity: "neutral",
      metric: "Everything ran sequentially — zero delegation",
      evidence: `${totalEvents} events, zero parallel agents. Single-threaded workflow.`,
      action: "Try subagents for research — fire 3-5 at once instead of one by one.",
      roi: "One parallel burst turns 10 minutes of research into 2 minutes.",
    });
  }

  // ── S3: Low agent completion ──
  if (del.launched >= 5 && del.completionRate < 60) {
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `Only ${del.completionRate}% of agents complete successfully`,
      evidence: `${del.launched} launched, ${del.completed} completed. ${del.launched - del.completed} failed or timed out.`,
      action: "Simplify agent prompts. Break complex tasks into smaller units.",
      roi: "Higher completion = less wasted compute.",
    });
  }

  // ── S4: Parallel burst champion ──
  if (del.maxConcurrent >= 4) {
    ins.push({
      icon: <Cpu className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `Peak parallelism: ${del.maxConcurrent} agents simultaneously`,
      evidence: `${del.parallelBursts} bursts of parallel work. Maximum throughput achieved.`,
      action: "You're using the platform at full capacity. Well done.",
      roi: `Peak parallelism multiplies throughput by ${del.maxConcurrent}x.`,
    });
  }

  // ── G1: High rejection rate ──
  if (gov.totalRejections > 10) {
    const topRej = gov.topRejected[0];
    ins.push({
      icon: <Shield className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `${gov.totalRejections} approaches rejected by user`,
      evidence: `Top rejected: ${topRej?.tool || 'unknown'} (${topRej?.count || 0} times). The agent keeps trying things you don't want.`,
      action: "Update CLAUDE.md with clearer constraints to prevent unwanted actions.",
      roi: `Better rules prevent ${gov.totalRejections} unnecessary tool calls.`,
    });
  }

  // ── G2: Productive session — commits + clean exit (★★ STRONG from agentisd #25) ──
  if (git.totalCommits > 0 && ei.totalErrors < 3) {
    ins.push({
      icon: <CheckCircle className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `Productive sessions — ${git.totalCommits} commits, clean exit`,
      evidence: `${git.totalCommits} commits with only ${ei.totalErrors} errors. Work shipped successfully.`,
      action: "Document what made this session productive — replicate the pattern.",
      roi: "Productive sessions compound. Each clean commit is future-proof.",
    });
  }

  // ── G3: Plan discipline ──
  if (gov.planApproved + gov.planRejected > 0 && gov.planApprovalRate > 80) {
    ins.push({
      icon: <CheckCircle className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `${gov.planApprovalRate}% of plans approved on first try`,
      evidence: `${gov.planApproved} plans approved, ${gov.planRejected} rejected. Strong alignment.`,
      action: "Strong planning discipline. Keep using plan mode for complex tasks.",
      roi: "Approved plans mean fewer mid-session course corrections.",
    });
  }

  // ── G4: Error rate high for event volume (★★ STRONG from agentisd #2) ──
  if (ei.totalErrors > 0 && totalEvents > 30) {
    const errorPct = Math.round(1000 * ei.totalErrors / totalEvents) / 10;
    if (errorPct > 15) {
      ins.push({
        icon: <AlertTriangle className="h-5 w-5 text-red-500" />, severity: "warning",
        metric: `${errorPct}% error rate — ${ei.totalErrors} errors in ${totalEvents} events`,
        evidence: `Error rate is above 15%. Most tools should succeed on first try. High error rate wastes compute.`,
        action: "Check repeating errors. Add error patterns to CLAUDE.md to prevent them.",
        roi: `Fixing the top error source saves ~${Math.round(ei.totalErrors * 1.5)} minutes of retry loops.`,
      });
    }
  }

  // ── H1: Rules loaded consistently ──
  if (ctx.uniqueRuleFiles > 0 && ctx.ruleLoadsPerSession > 1) {
    ins.push({
      icon: <FileCode className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: `${ctx.uniqueRuleFiles} rule files loaded consistently`,
      evidence: `${ctx.ruleLoadsPerSession.toFixed(1)} loads per session. Rules are guiding behavior.`,
      action: "Consistent rule loading means consistent behavior.",
      roi: "Rules prevent the top error patterns.",
    });
  }

  // ── H2: No rules ──
  if (ctx.uniqueRuleFiles === 0) {
    ins.push({
      icon: <FileCode className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: "No CLAUDE.md or rule files detected",
      evidence: "The agent runs without project-specific instructions.",
      action: "Create a CLAUDE.md with project conventions, constraints, and patterns.",
      roi: "Projects with CLAUDE.md consistently show lower error rates.",
    });
  }

  // H3 (low skill usage) removed — filler, not actionable
  // H4 (implement-heavy) removed — observational, no clear action

  // ── W1: Unresolved blockers ──
  if (ctx.totalBlockers > 0 && ctx.blockerResolutionRate < 50) {
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-red-500" />, severity: "critical",
      metric: `${ctx.totalBlockers - ctx.resolvedBlockers} unresolved blockers`,
      evidence: `Only ${ctx.blockerResolutionRate}% of blockers resolved. Open items: ${ctx.totalBlockers - ctx.resolvedBlockers}.`,
      action: "Document blockers for the next session or escalate.",
      roi: "Unresolved blockers multiply in cost over time.",
    });
  }

  // ── W2: CLAUDE.md update correlated with error drop (★★★ KILLER from agentisd #22) ──
  if (ctx.uniqueRuleFiles > 0 && ei.totalErrors > 0 && ei.resolutionRate > 50) {
    ins.push({
      icon: <FileCode className="h-5 w-5 text-emerald-500" />, severity: "positive",
      metric: "CLAUDE.md loaded + errors resolving — rules are working",
      evidence: `${ctx.uniqueRuleFiles} rule files loaded, ${ei.resolutionRate}% error resolution rate. Rules correlate with self-healing sessions.`,
      action: "Update CLAUDE.md when you discover new error patterns — each rule prevents future errors.",
      roi: "Sessions with rules loaded show measurably higher error resolution rates.",
    });
  }
  if (ctx.uniqueRuleFiles === 0 && ei.totalErrors > 5) {
    ins.push({
      icon: <FileCode className="h-5 w-5 text-red-500" />, severity: "critical",
      metric: `No CLAUDE.md + ${ei.totalErrors} errors — rules would prevent this`,
      evidence: `${ei.totalErrors} errors without any project rules loaded. CLAUDE.md is the #1 way to reduce errors.`,
      action: "Create CLAUDE.md with error patterns, constraints, and project conventions.",
      roi: "Adding CLAUDE.md is the single most impactful action for reducing errors.",
    });
  }

  // ── W3: Persistent struggle — same file across sessions (★★ STRONG from agentisd #13) ──
  if (fi.hotFiles.length > 0 && fi.hotFiles[0].touches > 8) {
    const worst = fi.hotFiles[0];
    ins.push({
      icon: <AlertTriangle className="h-5 w-5 text-red-500" />, severity: "warning",
      metric: `${worst.file.split('/').pop()} touched ${worst.touches} times — persistent struggle`,
      evidence: `File edited ${worst.touches} times across sessions. This suggests unclear requirements or wrong approach.`,
      action: "Write a spec or test first. Consider if the approach needs rethinking entirely.",
      roi: `Spec-first approach reduces rework from ${worst.touches} to ~3 edits.`,
    });
  }

  // X1-X4 composite scores shown as hero cards — only generate insight for critical scores
  if (cs.productivity < 40) {
    ins.push({
      icon: <TrendingUp className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `Productivity Score: ${cs.productivity}/100 — room to improve`,
      evidence: `Low commit rate or high rework. Consider structured planning before execution.`,
      action: "Start sessions with a plan. Commit incrementally. Delegate research to agents.",
      roi: "Planning + committing incrementally improves output consistency.",
    });
  }
  if (cs.quality < 40) {
    ins.push({
      icon: <Shield className="h-5 w-5 text-red-500" />, severity: "critical",
      metric: `Quality Score: ${cs.quality}/100 — needs attention`,
      evidence: `High error rate or unresolved errors. Retry loops detected.`,
      action: "Add error patterns to CLAUDE.md. Write tests first. Break retry loops early.",
      roi: "Addressing error patterns in-session prevents them from recurring.",
    });
  }
  if (cs.contextHealth < 40) {
    ins.push({
      icon: <Brain className="h-5 w-5 text-amber-500" />, severity: "warning",
      metric: `Context Health: ${cs.contextHealth}/100 — agent lacks guidance`,
      evidence: `Missing rules, few skills, no plans. The agent works without context.`,
      action: "Create CLAUDE.md, use plan mode, try skills like /commit.",
      roi: "Better context hygiene directly correlates with fewer errors.",
    });
  }

  return ins;
}

// ── Dashboard ──
function Dashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [catData, setCatData] = useState<CategoryAnalyticsData | null>(null);
  const [showAllInsights, setShowAllInsights] = useState(false);
  useEffect(() => {
    api.analytics().then(setData);
    api.categoryAnalytics().then(setCatData).catch(() => {}); // graceful — catData stays null, sections hidden
  }, []);
  if (!data) return <p className="text-muted-foreground animate-pulse">Loading analytics...</p>;

  const t = data.totals;
  const categoryInsights = catData ? generateCategoryInsights(catData) : [];
  const allInsights = [...generateInsights(data), ...categoryInsights];
  // Sort: critical first, then warning, positive, neutral
  const SEV_ORDER = { critical: 0, warning: 1, positive: 2, neutral: 3 };
  allInsights.sort((a, b) => (SEV_ORDER[a.severity] ?? 4) - (SEV_ORDER[b.severity] ?? 4));
  const insights = showAllInsights ? allInsights : allInsights.slice(0, 8);

  // Compute derived values
  const topTool = data.toolUsage[0];
  const topMcp = data.mcpTools[0];
  const peakHour = data.hourlyPattern.reduce((max, h) => h.count > (max?.count || 0) ? h : max, data.hourlyPattern[0]);
  const topProject = data.projectActivity[0];
  const topFile = data.fileActivity[0];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Dashboard</h2>
        <p className="text-sm text-muted-foreground mt-1">Personal insights · {t.totalSessions} sessions · {t.totalEvents} events</p>
      </div>

      <div className="space-y-6">

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Sessions" value={t.totalSessions} sub={`${t.avgSessionMin} min avg`} icon={Zap} color="text-blue-500" />
        <Stat label="Read:Write" value={`${t.readWriteRatio}:1`} sub={`${t.reads}R / ${t.writes}W`} icon={BookOpen} color="text-purple-500" />
        <Stat label="Compact Rate" value={`${t.compactRate}%`} sub={`${t.totalCompacts} compactions`} icon={Brain} color={t.compactRate > 60 ? "text-amber-500" : "text-emerald-500"} />
        <Stat label="Error Rate" value={`${t.errorRate}%`} sub={`${t.totalErrors} errors`} icon={Shield} color={t.errorRate > 10 ? "text-red-500" : "text-emerald-500"} />
        <Stat label="Prompts" value={t.promptsPerSession} sub="per session" icon={MessageSquare} color="text-cyan-500" />
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Insights & Actions</h3>
            <Badge variant="secondary" className="text-[10px]">{insights.length}</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {insights.map((ins, i) => <InsightCard key={i} {...ins} />)}
          </div>
          {allInsights.length > 8 && (
            <button
              onClick={() => setShowAllInsights(!showAllInsights)}
              className="mt-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showAllInsights ? "Show less" : `Show all ${allInsights.length} insights`}
            </button>
          )}
        </div>
      )}

      <Separator />

      {/* ── Tool Usage ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm">Tool Usage</CardTitle>
            </div>
            <CardDescription>What the agent does for you</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <Mini label="Total Calls" value={t.totalEvents} />
              <Mini label="Top Tool" value={topTool?.tool || "-"} color="text-blue-500" />
              <Mini label="Tools Used" value={data.toolUsage.length} color="text-purple-500" />
            </div>
            <div className="space-y-2">
              {data.toolUsage.slice(0, 8).map((tool, i) => {
                const pct = Math.round(100 * tool.count / t.totalEvents);
                return (
                  <div key={i}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="font-medium">{tool.tool}</span>
                      <span className="text-muted-foreground tabular-nums">{tool.count} <span className="text-muted-foreground/50">({pct}%)</span></span>
                    </div>
                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── MCP Tools ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Code className="h-4 w-4 text-purple-500" />
              <CardTitle className="text-sm">context-mode Tools</CardTitle>
            </div>
            <CardDescription>How you use the sandbox</CardDescription>
          </CardHeader>
          <CardContent>
            {data.mcpTools.length > 0 ? (
              <>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <Mini label="MCP Calls" value={data.mcpTools.reduce((a, b) => a + b.count, 0)} />
                  <Mini label="Top Tool" value={topMcp?.tool || "-"} color="text-purple-500" />
                  <Mini label="Tools Used" value={data.mcpTools.length} color="text-cyan-500" />
                </div>
                <RatioBar items={data.mcpTools.slice(0, 6).map((m, i) => ({
                  label: m.tool, value: m.count, color: COLORS[i % COLORS.length],
                }))} />
                <div className="mt-4 space-y-1.5">
                  {data.mcpTools.slice(0, 6).map((m, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-xs font-mono">{m.tool}</span>
                      <Badge variant="outline" className="text-[10px] tabular-nums">{m.count}</Badge>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="text-sm text-muted-foreground text-center py-12">No MCP data yet</p>}
          </CardContent>
        </Card>
      </div>

      {/* ── Session Activity + When You Code ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm">Session Activity</CardTitle>
            </div>
            <CardDescription>Your AI usage over time</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <Mini label="Total" value={t.totalSessions} />
              <Mini label="Avg Duration" value={`${t.avgSessionMin}m`} color="text-blue-500" />
              <Mini label="Active Days" value={data.sessionsByDate.length} color="text-emerald-500" />
            </div>
            {data.sessionsByDate.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-border">
                {data.sessionsByDate.slice(-7).map((d, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground tabular-nums min-w-[60px]">{d.date?.slice(5)}</span>
                    <div className="flex-1 flex gap-0.5">
                      {Array.from({ length: d.count }).map((_, j) => (
                        <div key={j} className="w-5 h-5 rounded-sm bg-blue-500/80" />
                      ))}
                      {d.compacts > 0 && Array.from({ length: d.compacts }).map((_, j) => (
                        <div key={`c${j}`} className="w-5 h-5 rounded-sm bg-amber-500/60" />
                      ))}
                    </div>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {d.count}s{d.compacts > 0 ? ` ${d.compacts}c` : ""}
                    </span>
                  </div>
                ))}
                <div className="flex gap-4 mt-2">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm bg-blue-500/80" /> Sessions
                  </span>
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm bg-amber-500/60" /> Compactions
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── When You Code ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-cyan-500" />
              <CardTitle className="text-sm">When You Code</CardTitle>
            </div>
            <CardDescription>Schedule deep work at your peak hours</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <Mini label="Peak Hour" value={peakHour ? `${String(peakHour.hour).padStart(2, "0")}:00` : "-"} color="text-cyan-500" />
              <Mini label="Peak Events" value={peakHour?.count || 0} />
              <Mini label="Active Hours" value={data.hourlyPattern.filter(h => h.count > 0).length} />
            </div>
            <div className="pt-2 border-t border-border">
              <div className="grid grid-cols-12 gap-1">
                {Array.from({ length: 24 }, (_, i) => {
                  const h = data.hourlyPattern.find(p => p.hour === i);
                  const count = h?.count || 0;
                  const max = peakHour?.count || 1;
                  const opacity = count > 0 ? 0.2 + 0.8 * (count / max) : 0.05;
                  return (
                    <div key={i} className="flex flex-col items-center gap-0.5">
                      <div
                        className="w-full aspect-square rounded-sm transition-all"
                        style={{ background: count > 0 ? `rgba(6, 182, 212, ${opacity})` : "hsl(var(--secondary))" }}
                        title={`${String(i).padStart(2, "0")}:00 — ${count} events`}
                      />
                      {i % 4 === 0 && <span className="text-[8px] text-muted-foreground/50">{i}</span>}
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-2">
                <span className="text-[9px] text-muted-foreground">00:00</span>
                <span className="text-[9px] text-muted-foreground">12:00</span>
                <span className="text-[9px] text-muted-foreground">23:00</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Project Focus + Hot Files ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-emerald-500" />
              <CardTitle className="text-sm">Project Focus</CardTitle>
            </div>
            <CardDescription>Where your AI time goes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <Mini label="Projects" value={t.uniqueProjects} />
              <Mini label="Top Project" value={topProject?.project_dir === "__unknown__" ? "Unknown" : topProject?.project_dir?.split("/").pop() || "-"} color="text-emerald-500" />
            </div>
            {data.attribution?.isFallbackOnly && (
              <div className="mb-3 px-3 py-2 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground flex items-center gap-1.5">
                <Lightbulb className="h-3 w-3 shrink-0" />
                Some project times are estimated
              </div>
            )}
            <div className="space-y-2.5 pt-2 border-t border-border">
              {data.projectActivity.slice(0, 6).map((p, i) => {
                const maxEv = data.projectActivity[0]?.events || 1;
                const pct = Math.round((p.events / maxEv) * 100);
                const name = p.project_dir === "__unknown__" ? "Unknown" : p.project_dir?.split("/").filter(Boolean).slice(-2).join("/") || "Unknown";
                return (
                  <div key={i}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-mono truncate max-w-[200px]">{name}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {p.sessions} sessions · {p.events} events
                      </span>
                    </div>
                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-sm">Hot Files</CardTitle>
            </div>
            <CardDescription>Most interacted — candidates for better tooling</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <Mini label="Files" value={data.fileActivity.length} />
              <Mini label="Top File" value={topFile?.file?.split("/").pop() || "-"} color="text-amber-500" />
              <Mini label="Top Hits" value={topFile?.count || 0} />
            </div>
            <div className="space-y-1 pt-2 border-t border-border">
              {data.fileActivity.slice(0, 8).map((f, i) => {
                const parts = f.file?.split("/") || [];
                const name = parts.pop() || f.file;
                const dir = parts.slice(-2).join("/");
                return (
                  <div key={i} className="flex items-center gap-2 py-0.5">
                    <Badge variant="outline" className="text-[10px] min-w-[28px] justify-center tabular-nums">{f.count}</Badge>
                    <span className="text-xs font-mono truncate">
                      {dir && <span className="text-muted-foreground/60">{dir}/</span>}{name}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Explore/Execute + Work Modes ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.exploreExecRatio.total > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-blue-500" />
                <CardTitle className="text-sm">Explore vs Execute</CardTitle>
              </div>
              <CardDescription>Reading code vs writing code — your work balance</CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const { explore, execute, total } = data.exploreExecRatio;
                const ratio = execute > 0 ? (explore / execute).toFixed(1) : explore;
                const explorePct = Math.round(100 * explore / Math.max(total, 1));
                const executePct = 100 - explorePct;
                return (
                  <>
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <Mini label="Explore" value={explore} color="text-blue-500" />
                      <Mini label="Execute" value={execute} color="text-emerald-500" />
                      <Mini label="Ratio" value={`${ratio}:1`} color={Number(ratio) > 6 ? "text-amber-500" : "text-foreground"} />
                    </div>
                    <RatioBar items={[
                      { label: `Read/Glob/Grep (${explorePct}%)`, value: explore, color: "#3b82f6" },
                      { label: `Write/Edit (${executePct}%)`, value: execute, color: "#10b981" },
                    ]} />
                  </>
                );
              })()}
            </CardContent>
          </Card>
        )}

        {data.workModes.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-purple-500" />
                <CardTitle className="text-sm">Work Modes</CardTitle>
              </div>
              <CardDescription>How you approach tasks — investigate, implement, review, explore</CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const total = data.workModes.reduce((a, b) => a + b.count, 0);
                return (
                  <>
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <Mini label="Total Intents" value={total} />
                      <Mini label="Top Mode" value={data.workModes[0]?.mode || "-"} color="text-purple-500" />
                      <Mini label="Modes" value={data.workModes.length} />
                    </div>
                    <RatioBar items={data.workModes.map((m, i) => ({
                      label: m.mode, value: m.count, color: COLORS[i % COLORS.length],
                    }))} />
                  </>
                );
              })()}
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Tool Mastery + Commit Rate ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Tool Mastery Curve */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-500" />
              <CardTitle className="text-sm">Tool Mastery</CardTitle>
            </div>
            <CardDescription>Are you getting better over time?</CardDescription>
          </CardHeader>
          <CardContent>
            {data.masteryTrend && data.masteryTrend.length > 0 ? (() => {
              const last = data.masteryTrend[data.masteryTrend.length - 1];
              const first = data.masteryTrend[0];
              const improving = last.error_rate < first.error_rate;
              return (
                <>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <Mini label="Weeks" value={data.masteryTrend.length} />
                    <Mini label="Latest" value={`${last.error_rate}%`} color={last.error_rate < 5 ? "text-emerald-500" : last.error_rate > 10 ? "text-amber-500" : ""} />
                    <Mini label="Trend" value={improving ? "\u2193" : "\u2191"} color={improving ? "text-emerald-500" : "text-red-500"} />
                  </div>
                  <div className="space-y-1.5 pt-2 border-t border-border">
                    {data.masteryTrend.slice(-6).map((w, i) => {
                      const maxRate = Math.max(...data.masteryTrend.map(m => m.error_rate), 1);
                      const pct = Math.round((w.error_rate / maxRate) * 100);
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground tabular-nums min-w-[50px]">{w.week?.slice(5)}</span>
                          <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 3)}%`, background: w.error_rate < 5 ? "#10b981" : w.error_rate > 10 ? "#f59e0b" : "#3b82f6" }} />
                          </div>
                          <span className="text-[10px] text-muted-foreground tabular-nums">{w.error_rate}%</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                    {last.error_rate === 0 && first.error_rate <= 1
                      ? "Near-zero error rate across all weeks — you're writing precise, clean prompts."
                      : improving
                      ? `Error rate dropped from ${first.error_rate}% to ${last.error_rate}% — your skills are improving.`
                      : `Error rate went from ${first.error_rate}% to ${last.error_rate}%. Check what changed — new tools, different project, or prompt drift?`}
                  </p>
                </>
              );
            })() : <p className="text-sm text-muted-foreground text-center py-12">Not enough data yet</p>}
          </CardContent>
        </Card>

        {/* Commit Rate */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-emerald-500" />
              <CardTitle className="text-sm">Commit Rate</CardTitle>
            </div>
            <CardDescription>How productive are your sessions?</CardDescription>
          </CardHeader>
          <CardContent>
            {(() => {
              const commits = t.totalCommits || 0;
              const perSession = t.commitsPerSession || 0;
              const sessionsWithCommit = data.commitRate ? data.commitRate.filter(c => c.commits > 0).length : 0;
              return (
                <>
                  <div className="grid grid-cols-3 gap-4 mb-3">
                    <Mini label="Commits" value={commits} />
                    <Mini label="Per Session" value={perSession} color={perSession >= 1 ? "text-emerald-500" : "text-muted-foreground"} />
                    <Mini label="Sessions w/ Commit" value={sessionsWithCommit} color="text-blue-500" />
                  </div>
                  <div className="pt-2 border-t border-border">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {perSession >= 1
                        ? "Strong output — you're committing consistently every session."
                        : perSession > 0
                        ? `${commits} commit in ${t.totalSessions} sessions. Most sessions are research/exploration — commits come in focused bursts.`
                        : "No commits yet. That's fine if you're in exploration or debugging mode — commits will come when you ship."}
                    </p>
                  </div>
                </>
              );
            })()}
          </CardContent>
        </Card>

      </div>

      {/* ── Rules Health + Edit-Test Cycles ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* CLAUDE.md Health */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-sm">Rules Health</CardTitle>
            </div>
            <CardDescription>Are your instruction files maintained?</CardDescription>
          </CardHeader>
          <CardContent>
            {data.rulesFreshness && data.rulesFreshness.length > 0 ? (() => {
              const top = data.rulesFreshness[0];
              const topName = top.rule_path?.split("/").pop() || top.rule_path;
              return (
                <>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <Mini label="Rules" value={t.totalRules || data.rulesFreshness.length} />
                    <Mini label="Most Loaded" value={topName} color="text-amber-500" />
                    <Mini label="Loads" value={top.load_count} />
                  </div>
                  <div className="space-y-1.5 pt-2 border-t border-border">
                    {data.rulesFreshness.slice(0, 6).map((r, i) => {
                      const name = r.rule_path?.split("/").pop() || r.rule_path;
                      const lastSeen = r.last_seen ? (() => {
                        const diff = Date.now() - new Date(r.last_seen).getTime();
                        const days = Math.floor(diff / 86400000);
                        return days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
                      })() : "unknown";
                      return (
                        <div key={i} className="flex items-center justify-between py-0.5">
                          <span className="text-xs font-mono truncate max-w-[200px]">{name}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground">{lastSeen}</span>
                            <Badge variant="outline" className="text-[10px] tabular-nums">{r.load_count}</Badge>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })() : <p className="text-sm text-muted-foreground text-center py-12">No rules data yet</p>}
          </CardContent>
        </Card>

        {/* Edit-Test Cycles */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-sm">Edit → Error Cycles</CardTitle>
            </div>
            <CardDescription>Write → fail → fix again loops</CardDescription>
          </CardHeader>
          <CardContent>
            {(() => {
              const cycles = t.totalEditTestCycles || 0;
              const perSession = t.totalSessions > 0 ? (cycles / t.totalSessions).toFixed(1) : "0";
              const sessionsHit = data.editTestCycles ? data.editTestCycles.length : 0;

              if (cycles === 0) {
                return (
                  <div className="pt-2">
                    <div className="flex items-center gap-2 mb-3">
                      <CheckCircle className="h-5 w-5 text-emerald-500" />
                      <span className="text-sm font-semibold">Zero retry loops</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      No write→error→rewrite patterns detected. Your code works on the first try — clean prompting and clear instructions pay off.
                    </p>
                  </div>
                );
              }

              return (
                <>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <Mini label="Total Cycles" value={cycles} />
                    <Mini label="Per Session" value={perSession} color={Number(perSession) > 3 ? "text-amber-500" : "text-emerald-500"} />
                    <Mini label="Sessions Hit" value={sessionsHit} />
                  </div>
                  <div className="pt-2 border-t border-border">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {Number(perSession) > 3
                        ? "High retry rate — consider writing tests first or adding patterns to CLAUDE.md to prevent common errors."
                        : `${cycles} retry loops across ${sessionsHit} sessions. Manageable — keep an eye on which files trigger retries.`}
                    </p>
                  </div>
                </>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {/* ── Git Flow + Parallel Work ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.gitActivity.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-emerald-500" />
                <CardTitle className="text-sm">Git Flow</CardTitle>
              </div>
              <CardDescription>Your version control pattern per session</CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const commits = data.gitActivity.filter(g => g.action === "commit").length;
                const pushes = data.gitActivity.filter(g => g.action === "push").length;
                // Group by session
                const sessions = new Map<string, { project: string; actions: string[]; time: string }>();
                data.gitActivity.forEach(g => {
                  if (!sessions.has(g.session_id)) {
                    sessions.set(g.session_id, {
                      project: g.project_dir === "__unknown__" ? "Unknown" : g.project_dir?.split("/").filter(Boolean).slice(-2).join("/") || "-",
                      actions: [],
                      time: g.created_at,
                    });
                  }
                  sessions.get(g.session_id)!.actions.push(g.action);
                });
                return (
                  <>
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <Mini label="Git Ops" value={data.gitActivity.length} />
                      <Mini label="Commits" value={commits} color="text-emerald-500" />
                      <Mini label="Pushes" value={pushes} color="text-blue-500" />
                    </div>
                    <div className="space-y-2.5 pt-2 border-t border-border">
                      {[...sessions.entries()].slice(0, 5).map(([sid, s]) => (
                        <div key={sid}>
                          <div className="flex justify-between text-[10px] mb-1">
                            <span className="font-mono text-muted-foreground">{s.project}</span>
                            <span className="text-muted-foreground">{s.time?.slice(5, 16)}</span>
                          </div>
                          <div className="flex gap-1">
                            {s.actions.map((a, i) => (
                              <Badge key={i} variant={a === "commit" || a === "push" ? "default" : "secondary"} className="text-[9px]">{a}</Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()}
            </CardContent>
          </Card>
        )}

        {data.subagents.total > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-purple-500" />
                <CardTitle className="text-sm">Parallel Work</CardTitle>
              </div>
              <CardDescription>How effectively you delegate to subagents</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <Mini label="Delegated" value={data.subagents.total} />
                <Mini label="Max Parallel" value={data.subagents.maxConcurrent} color="text-purple-500" />
                <Mini label="Time Saved" value={`~${data.subagents.timeSavedMin}m`} color="text-emerald-500" />
              </div>
              <RatioBar items={[
                { label: "Parallel", value: data.subagents.parallelCount, color: "#8b5cf6" },
                { label: "Sequential", value: data.subagents.sequentialCount, color: "hsl(var(--muted))" },
              ]} />
              {data.subagents.burstDetails.length > 0 && (
                <div className="space-y-1.5 pt-3 mt-3 border-t border-border">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">Parallel Bursts</p>
                  {data.subagents.burstDetails.map((b: { size: number; time: string }, i: number) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground tabular-nums">{b.time?.slice(5, 16)}</span>
                      <div className="flex gap-0.5">
                        {Array.from({ length: b.size }).map((_, j) => (
                          <div key={j} className="w-3 h-3 rounded-sm bg-purple-500/80" />
                        ))}
                      </div>
                      <span className="text-[10px] text-muted-foreground">{b.size} agents</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {catData && !catData.insufficientData && (
        <>
          <Separator />

          {/* ── Category Intelligence ── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Cpu className="h-4 w-4 text-purple-500" />
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Session Intelligence</h3>
            </div>

            {/* Composite Scores */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <Card className={catData.compositeScores.productivity >= 70 ? "border-emerald-500/30" : catData.compositeScores.productivity < 40 ? "border-red-500/30" : "border-amber-500/30"}>
                <CardContent className="pt-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold tabular-nums">{catData.compositeScores.productivity}</div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Productivity</p>
                  </div>
                </CardContent>
              </Card>
              <Card className={catData.compositeScores.quality >= 70 ? "border-emerald-500/30" : catData.compositeScores.quality < 40 ? "border-red-500/30" : "border-amber-500/30"}>
                <CardContent className="pt-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold tabular-nums">{catData.compositeScores.quality}</div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Quality</p>
                  </div>
                </CardContent>
              </Card>
              <Card className={catData.compositeScores.delegation >= 70 ? "border-emerald-500/30" : catData.compositeScores.delegation < 40 ? "border-red-500/30" : "border-amber-500/30"}>
                <CardContent className="pt-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold tabular-nums">{catData.compositeScores.delegation}</div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Delegation</p>
                  </div>
                </CardContent>
              </Card>
              <Card className={catData.compositeScores.contextHealth >= 70 ? "border-emerald-500/30" : catData.compositeScores.contextHealth < 40 ? "border-red-500/30" : "border-amber-500/30"}>
                <CardContent className="pt-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold tabular-nums">{catData.compositeScores.contextHealth}</div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Context Health</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Category Distribution */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-blue-500" />
                    <CardTitle className="text-sm">Event Categories</CardTitle>
                  </div>
                  <CardDescription>{catData.categories.reduce((a, b) => a + b.count, 0)} events across {catData.categories.filter(c => c.count > 0).length} categories</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {catData.categories.filter(c => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 12).map((cat, i) => {
                      const max = catData.categories.reduce((a, b) => Math.max(a, b.count), 0);
                      return (
                        <div key={cat.category} className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground w-28 truncate">{cat.category}</span>
                          <div className="flex-1 h-5 bg-muted/50 rounded-sm overflow-hidden">
                            <div className="h-full rounded-sm" style={{ width: `${(cat.count / max) * 100}%`, backgroundColor: COLORS[i % COLORS.length] }} />
                          </div>
                          <span className="text-[11px] tabular-nums text-muted-foreground w-8 text-right">{cat.count}</span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Error Intelligence */}
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-red-500" />
                    <CardTitle className="text-sm">Error Intelligence</CardTitle>
                  </div>
                  <CardDescription>Resolution rate, retry storms, latency</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <Mini label="Errors" value={catData.errorIntelligence.totalErrors} />
                    <Mini label="Resolved" value={`${catData.errorIntelligence.resolutionRate}%`} color={catData.errorIntelligence.resolutionRate > 70 ? "text-emerald-500" : "text-amber-500"} />
                    <Mini label="Retry Storms" value={catData.errorIntelligence.retryStorms} color={catData.errorIntelligence.retryStorms > 0 ? "text-red-500" : ""} />
                  </div>
                  {catData.errorIntelligence.latencyByTool.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Slowest Tools</p>
                      {catData.errorIntelligence.latencyByTool.slice(0, 5).map((t) => (
                        <div key={t.tool} className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground w-20 truncate">{t.tool}</span>
                          <div className="flex-1 h-4 bg-muted/50 rounded-sm overflow-hidden">
                            <div className="h-full bg-amber-500/60 rounded-sm" style={{ width: `${Math.min((t.avg_ms / 30000) * 100, 100)}%` }} />
                          </div>
                          <span className="text-[11px] tabular-nums text-muted-foreground w-12 text-right">{(t.avg_ms / 1000).toFixed(1)}s</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {catData.errorIntelligence.topErrorTools.length > 0 && (
                    <div className="space-y-1.5 mt-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Top Error Sources</p>
                      {catData.errorIntelligence.topErrorTools.slice(0, 5).map((t) => (
                        <div key={t.tool} className="flex items-center justify-between">
                          <span className="text-[11px] text-muted-foreground">{t.tool}</span>
                          <Badge variant="secondary" className="text-[10px]">{t.count}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Separator />

          {/* ── Governance + Delegation ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-purple-500" />
                  <CardTitle className="text-sm">Governance</CardTitle>
                </div>
                <CardDescription>Decisions, rejections, plans, constraints</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <Mini label="Rejections" value={catData.governance.totalRejections} color={catData.governance.totalRejections > 20 ? "text-amber-500" : ""} />
                  <Mini label="Decisions" value={catData.governance.totalDecisions} />
                  <Mini label="Plans Approved" value={catData.governance.planApproved} />
                  <Mini label="Constraints" value={catData.governance.totalConstraints} />
                </div>
                {catData.governance.topRejected.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Top Rejected Tools</p>
                    {catData.governance.topRejected.slice(0, 5).map((t) => (
                      <div key={t.tool} className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">{t.tool}</span>
                        <Badge variant="secondary" className="text-[10px]">{t.count}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-emerald-500" />
                  <CardTitle className="text-sm">Delegation</CardTitle>
                </div>
                <CardDescription>Agent parallelism and completion</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <Mini label="Launched" value={catData.delegation.launched} />
                  <Mini label="Completed" value={catData.delegation.completed} />
                  <Mini label="Rate" value={`${catData.delegation.completionRate}%`} color={catData.delegation.completionRate > 70 ? "text-emerald-500" : "text-amber-500"} />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <Mini label="Bursts" value={catData.delegation.parallelBursts} />
                  <Mini label="Max ∥" value={catData.delegation.maxConcurrent} />
                  <Mini label="Saved" value={`${catData.delegation.timeSavedMin}m`} color="text-emerald-500" />
                </div>
              </CardContent>
            </Card>
          </div>

          <Separator />

          {/* ── Git Productivity + Context Health ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-blue-500" />
                  <CardTitle className="text-sm">Git Productivity</CardTitle>
                </div>
                <CardDescription>Commit patterns and operation mix</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <Mini label="Commits" value={catData.gitProductivity.totalCommits} />
                  <Mini label="Pushes" value={catData.gitProductivity.totalPushes} />
                  <Mini label="C:P Ratio" value={catData.gitProductivity.commitPushRatio > 0 ? `${catData.gitProductivity.commitPushRatio}:1` : "—"} />
                </div>
                {catData.gitProductivity.operationMix.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Git Operations</p>
                    {catData.gitProductivity.operationMix.slice(0, 8).map((op) => {
                      const max = catData.gitProductivity.operationMix[0]?.count || 1;
                      return (
                        <div key={op.operation} className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground w-16 truncate">{op.operation}</span>
                          <div className="flex-1 h-4 bg-muted/50 rounded-sm overflow-hidden">
                            <div className="h-full bg-blue-500/60 rounded-sm" style={{ width: `${(op.count / max) * 100}%` }} />
                          </div>
                          <span className="text-[11px] tabular-nums text-muted-foreground w-6 text-right">{op.count}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-cyan-500" />
                  <CardTitle className="text-sm">Context Health</CardTitle>
                </div>
                <CardDescription>Rules, skills, work modes, blockers</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <Mini label="Rule Files" value={catData.contextHealth.uniqueRuleFiles} />
                  <Mini label="Skills" value={catData.contextHealth.uniqueSkills} />
                  <Mini label="Compact Rate" value={`${catData.contextHealth.compactRate}%`} color={catData.contextHealth.compactRate > 60 ? "text-amber-500" : "text-emerald-500"} />
                </div>
                {catData.contextHealth.modeDistribution.length > 0 && (
                  <div className="mb-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Work Modes</p>
                    <RatioBar items={catData.contextHealth.modeDistribution.map((m, i) => ({
                      label: `${m.mode} (${m.pct}%)`,
                      value: m.count,
                      color: COLORS[i % COLORS.length],
                    }))} />
                  </div>
                )}
                {catData.contextHealth.skillList.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Active Skills</p>
                    <div className="flex flex-wrap gap-1">
                      {catData.contextHealth.skillList.map(s => (
                        <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {catData.contextHealth.totalBlockers > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    <Mini label="Blockers" value={catData.contextHealth.totalBlockers} color="text-amber-500" />
                    <Mini label="Resolved" value={`${catData.contextHealth.blockerResolutionRate}%`} color={catData.contextHealth.blockerResolutionRate > 70 ? "text-emerald-500" : "text-red-500"} />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      </div>
    </div>
  );
}
