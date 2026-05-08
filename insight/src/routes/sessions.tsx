import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type SessionDB, type SessionMeta } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { timeAgo, formatDuration } from "@/components/analytics";
import { Zap, Clock, Activity, ChevronRight, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/sessions")({ component: Sessions });

function Sessions() {
  const [dbs, setDbs] = useState<SessionDB[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.sessions().then(d => { setDbs(d); setLoading(false); }); }, []);

  if (loading) return <p className="text-muted-foreground animate-pulse">Loading sessions...</p>;

  const nonEmpty = dbs.filter(db => db.sessions.length > 0);

  if (nonEmpty.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold">Sessions</h2>
          <p className="text-sm text-muted-foreground mt-1">No sessions with events found</p>
        </div>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Sessions appear here once your AI coding tools start generating events.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Flatten all sessions
  const allSessions: { session: SessionMeta; dbHash: string }[] = [];
  for (const db of nonEmpty) {
    for (const s of db.sessions) {
      allSessions.push({ session: s, dbHash: db.hash });
    }
  }

  // Compute KPIs
  const totalSessions = allSessions.length;
  const totalEvents = allSessions.reduce((a, s) => a + s.session.eventCount, 0);

  // Compute average duration from startedAt to lastEventAt
  let totalDurationMin = 0;
  let durCount = 0;
  for (const { session: s } of allSessions) {
    if (s.startedAt && s.lastEventAt) {
      const start = new Date(s.startedAt).getTime();
      const end = new Date(s.lastEventAt).getTime();
      if (!isNaN(start) && !isNaN(end) && end > start) {
        totalDurationMin += (end - start) / 60000;
        durCount++;
      }
    }
  }
  const avgDuration = durCount > 0 ? Math.round(totalDurationMin / durCount) : 0;

  // Sort by startedAt descending
  allSessions.sort((a, b) => (b.session.startedAt || "").localeCompare(a.session.startedAt || ""));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Sessions</h2>
        <p className="text-sm text-muted-foreground mt-1">
          All recorded AI coding sessions
        </p>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Sessions</CardTitle>
            <Zap className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalSessions}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">across {nonEmpty.length} db{nonEmpty.length > 1 ? "s" : ""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Avg Duration</CardTitle>
            <Clock className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{formatDuration(avgDuration)}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">per session</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Events</CardTitle>
            <Activity className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalEvents}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{totalSessions > 0 ? `~${Math.round(totalEvents / totalSessions)} per session` : "none"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Session cards */}
      <div className="grid gap-2">
        {allSessions.map(({ session: s, dbHash }) => {
          // Compute duration
          let durationMin = 0;
          if (s.startedAt && s.lastEventAt) {
            const start = new Date(s.startedAt).getTime();
            const end = new Date(s.lastEventAt).getTime();
            if (!isNaN(start) && !isNaN(end) && end > start) {
              durationMin = (end - start) / 60000;
            }
          }

          // Project name: last 2 path segments
          const projectName = !s.projectDir || s.projectDir === "__unknown__"
            ? "Unknown"
            : s.projectDir.split("/").filter(Boolean).slice(-2).join("/") || "Unknown";

          return (
            <Link
              key={`${dbHash}-${s.id}`}
              to="/sessions/$dbHash/$sessionId"
              params={{ dbHash, sessionId: s.id }}
              className="block group"
            >
              <Card className="transition-colors hover:border-primary/30">
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    {/* Project name */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium truncate">{projectName}</span>
                        {s.compactCount > 0 && (
                          <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/30 shrink-0">
                            <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                            {s.compactCount} compact{s.compactCount > 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono">{s.id.slice(0, 16)}</span>
                    </div>

                    {/* Duration badge */}
                    {durationMin > 0 && (
                      <Badge variant="secondary" className="text-[10px] tabular-nums shrink-0">
                        {formatDuration(durationMin)}
                      </Badge>
                    )}

                    {/* Event count */}
                    <Badge variant="secondary" className="text-[10px] tabular-nums shrink-0">
                      {s.eventCount} event{s.eventCount !== 1 ? "s" : ""}
                    </Badge>

                    {/* Started time */}
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 min-w-[50px] text-right">
                      {timeAgo(s.startedAt)}
                    </span>

                    <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
