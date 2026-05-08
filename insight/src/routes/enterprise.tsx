import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Building2, Sparkles, DollarSign, TestTube2, GraduationCap, ArrowRight,
  Mail, Cloud, ShieldCheck, GitPullRequest, Monitor, Users, Shield, Code,
} from "lucide-react";

export const Route = createFileRoute("/enterprise")({ component: EnterprisePage });

// ── Enterprise Persona Data ──
const PERSONAS = [
  {
    name: "CTO / VP Engineering",
    icon: Building2,
    metrics: 6,
    blocked: 2,
    color: "border-blue-500/30",
    bg: "bg-blue-500/5",
    badge: "bg-blue-500/15 text-blue-400",
    insights: [
      "57 idle licenses = $27K/yr waste",
      "AI adoption at 68% — 32% of seats unused",
    ],
    roi: "$27K/yr license savings",
  },
  {
    name: "Engineering Manager",
    icon: Users,
    metrics: 7,
    color: "border-purple-500/30",
    bg: "bg-purple-500/5",
    badge: "bg-purple-500/15 text-purple-400",
    insights: [
      "Dev A takes 3.2hr to first commit vs team avg 1.8hr",
      "Team rework rate 47 edits/file — specs unclear",
    ],
    roi: "2.6x sprint velocity improvement",
  },
  {
    name: "DevEx Lead",
    icon: Sparkles,
    metrics: 7,
    color: "border-cyan-500/30",
    bg: "bg-cyan-500/5",
    badge: "bg-cyan-500/15 text-cyan-400",
    insights: [
      "42% of devs quit the tool after 3 days",
      "New hire ramp: 6 weeks to 2 weeks with context-mode",
    ],
    roi: "6wk to 2wk onboarding",
  },
  {
    name: "Security / CISO",
    icon: Shield,
    metrics: 5,
    color: "border-red-500/30",
    bg: "bg-red-500/5",
    badge: "bg-red-500/15 text-red-400",
    insights: [
      "AWS key appeared in tool output for 7 minutes",
      "12 dangerous command attempts blocked this week",
    ],
    roi: "Full SOC2 AI audit trail",
  },
  {
    name: "FinOps",
    icon: DollarSign,
    metrics: 1,
    blocked: 4,
    muted: true,
    color: "border-zinc-500/20",
    bg: "bg-zinc-500/5",
    badge: "bg-zinc-500/15 text-zinc-500",
    insights: [
      "Cost data requires platform changes — 4 metrics blocked",
    ],
    roi: "15-30% cost optimization (when unblocked)",
    comingSoon: true,
  },
  {
    name: "QA Lead",
    icon: TestTube2,
    metrics: 5,
    color: "border-amber-500/30",
    bg: "bg-amber-500/5",
    badge: "bg-amber-500/15 text-amber-400",
    insights: [
      "Only 28% of sessions run tests",
      "35% first-pass test rate — quality crisis signal",
    ],
    roi: "Targeted tech debt sprints",
  },
  {
    name: "Developer",
    icon: Code,
    metrics: 5,
    color: "border-emerald-500/30",
    bg: "bg-emerald-500/5",
    badge: "bg-emerald-500/15 text-emerald-400",
    insights: [
      "Error rate dropped 60% after updating CLAUDE.md",
      "Tool mastery curve: 34% to 11% errors in 8 weeks",
    ],
    roi: "Personal mastery curve",
    note: "Already in Personal tab",
  },
  {
    name: "Onboarding",
    icon: GraduationCap,
    metrics: 5,
    color: "border-orange-500/30",
    bg: "bg-orange-500/5",
    badge: "bg-orange-500/15 text-orange-400",
    insights: [
      "New hire first commit: 4.2hr vs team avg 1.8hr",
      "Tool discovery: 3 tools week 1 to 8 tools week 6",
    ],
    roi: "4x faster ramp time",
  },
] as const;

// ── Enterprise Persona Card ──
function PersonaCard({ persona }: { persona: typeof PERSONAS[number] }) {
  const Icon = persona.icon;
  const isMuted = "muted" in persona && persona.muted;
  return (
    <Card className={`${persona.color} ${persona.bg} ${isMuted ? "opacity-50" : ""}`}>
      <CardContent className="p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`rounded-lg p-2 ${persona.bg}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-bold truncate">{persona.name}</h4>
            {"comingSoon" in persona && persona.comingSoon && (
              <Badge variant="outline" className="text-[9px] text-zinc-500 border-zinc-500/30">Coming Soon</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${persona.badge}`}>
              {persona.metrics} metrics
            </span>
            {"blocked" in persona && persona.blocked && (
              <span className="text-[10px] text-muted-foreground">{persona.blocked} blocked</span>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1.5 mb-3">
        {persona.insights.map((insight, i) => (
          <div key={i} className="flex items-start gap-2">
            <ArrowRight className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground leading-relaxed">{insight}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg bg-background/40 px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">ROI</p>
        <p className="text-xs font-semibold">{persona.roi}</p>
      </div>

      {"note" in persona && persona.note && (
        <p className="text-[10px] text-muted-foreground mt-2 italic">{persona.note}</p>
      )}
      </CardContent>
    </Card>
  );
}

// ── Enterprise Page ──
function EnterprisePage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Enterprise</h2>
        <p className="text-sm text-muted-foreground mt-1">Team analytics, compliance, and cloud sessions</p>
      </div>

      {/* Header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-blue-500/10 p-2.5">
              <Building2 className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h2 className="text-xl font-bold">context-mode for Enterprise</h2>
              <p className="text-sm text-muted-foreground">56 metrics · 8 personas · 143 actionable insights</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The open source plugin handles individual developers.
            For teams, we're building a managed analytics layer.
          </p>
        </CardContent>
      </Card>

      {/* Enterprise Value Props — 2x2 Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">Context as a Service — API</CardTitle>
            <Cloud className="h-4 w-4 text-cyan-500" />
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-4">
              Your AI tools produce session data that no other tool can see. We expose it as an API.
            </CardDescription>
            <div className="flex flex-wrap gap-2 mb-4">
              <Badge variant="secondary" className="text-[10px]">CI/CD Pipelines</Badge>
              <Badge variant="secondary" className="text-[10px]">Code Review</Badge>
              <Badge variant="secondary" className="text-[10px]">Compliance</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Twilio model: plugin free, API paid.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">For your CISO</CardTitle>
            <ShieldCheck className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-4 italic">
              "What did the AI do? Which files did it access? Did it run anything dangerous? Can we prove it for SOC2?"
            </CardDescription>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] shrink-0">Audit</Badge>
                <span className="text-xs text-muted-foreground">Every tool call, every file access, timestamped</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] shrink-0">SOC2</Badge>
                <span className="text-xs text-muted-foreground">Automated compliance reports</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">For your DevOps</CardTitle>
            <GitPullRequest className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-4 italic">
              "AI edited 47 files in this PR, 3 have no tests, 4 edit-run-fix cycles on auth.ts. Should we merge?"
            </CardDescription>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="text-[10px]">GitHub Actions</Badge>
              <Badge variant="secondary" className="text-[10px]">AI risk scoring</Badge>
              <Badge variant="secondary" className="text-[10px]">Deploy gates</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">For your developers</CardTitle>
            <Monitor className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-4 italic">
              "I was debugging auth.ts yesterday on my laptop. Now I'm on my desktop. Where was I?"
            </CardDescription>
            <p className="text-xs font-semibold">Cloud sessions. Any device, any time. Full history.</p>
          </CardContent>
        </Card>
      </div>

      {/* Persona Grid */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Users className="h-4 w-4 text-purple-500" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Who Gets What</h3>
          <Badge variant="secondary" className="text-[10px]">8 personas</Badge>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {PERSONAS.map((persona, i) => (
            <PersonaCard key={i} persona={persona} />
          ))}
        </div>
      </div>

      <Separator />

      {/* CTA */}
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <h3 className="text-base font-bold mb-1">We're onboarding design partners</h3>
              <p className="text-sm text-muted-foreground">
                5 spots for teams that want to shape the product. Free access during the design phase.
              </p>
            </div>
            <a
              href="mailto:bm.ksglu@gmail.com?subject=context-mode%20Enterprise%20—%20Design%20Partner"
              className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors shrink-0"
            >
              <Mail className="h-4 w-4" />
              Contact Us
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
