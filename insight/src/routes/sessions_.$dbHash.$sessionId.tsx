import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type SessionEventData } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RatioBar, formatDuration, COLORS } from "@/components/analytics";
import { ArrowLeft, ChevronDown, ChevronRight, Zap, Clock, Layers } from "lucide-react";

export const Route = createFileRoute("/sessions_/$dbHash/$sessionId")({ component: EventView });

function EventRow({ e }: { e: { id: number; type: string; priority: number; data: string | null; created_at: string | null } }) {
  const [expanded, setExpanded] = useState(false);
  const raw = e.data || "-";
  const truncated = raw.length > 100 ? raw.slice(0, 100) + "..." : raw;
  const needsExpand = raw.length > 100;

  return (
    <div
      className={`flex gap-3 py-2 border-b border-border/50 text-sm ${needsExpand ? "cursor-pointer hover:bg-accent/30" : ""}`}
      onClick={() => needsExpand && setExpanded(prev => !prev)}
    >
      <span className="text-xs text-muted-foreground font-mono whitespace-nowrap min-w-[130px]">
        {e.created_at || "-"}
      </span>
      <Badge variant={e.priority >= 3 ? "default" : "secondary"} className="text-[10px] shrink-0 h-5">
        {e.type}
      </Badge>
      <div className="flex-1 min-w-0">
        <span className={`text-xs ${expanded ? "whitespace-pre-wrap break-words" : "block truncate"} ${
          e.priority >= 4 ? "text-red-500 font-semibold" : e.priority >= 3 ? "text-amber-500" : "text-muted-foreground"
        }`}>
          {expanded ? raw : truncated}
        </span>
      </div>
      {needsExpand && (
        <span className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      )}
    </div>
  );
}

function EventView() {
  const { dbHash, sessionId } = Route.useParams();
  const [data, setData] = useState<SessionEventData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.events(dbHash, sessionId).then(d => { setData(d); setLoading(false); });
  }, [dbHash, sessionId]);

  if (loading || !data) return <p className="text-muted-foreground animate-pulse">Loading session...</p>;

  // Compute type counts
  const typeCounts: Record<string, number> = {};
  data.events.forEach(e => { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const uniqueTypes = typeEntries.length;

  // Compute duration from first to last event
  let durationMin = 0;
  if (data.events.length >= 2) {
    const first = data.events[0]?.created_at;
    const last = data.events[data.events.length - 1]?.created_at;
    if (first && last) {
      const start = new Date(first).getTime();
      const end = new Date(last).getTime();
      if (!isNaN(start) && !isNaN(end) && end > start) {
        durationMin = (end - start) / 60000;
      }
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/sessions" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Sessions
      </Link>

      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold">Session Detail</h2>
        {data.resume && <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">Resume available</Badge>}
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Events</CardTitle>
            <Zap className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{data.events.length}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">total in session</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Duration</CardTitle>
            <Clock className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{formatDuration(durationMin)}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">first to last event</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Types</CardTitle>
            <Layers className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{uniqueTypes}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">unique event types</p>
          </CardContent>
        </Card>
      </div>

      {/* Event type breakdown as ratio bar */}
      {typeEntries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Event Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <RatioBar items={typeEntries.slice(0, 8).map(([ type, count ], i) => ({
              label: type, value: count, color: COLORS[i % COLORS.length],
            }))} />
          </CardContent>
        </Card>
      )}

      {/* Event type badges */}
      <div className="flex flex-wrap gap-1.5">
        {typeEntries.map(([type, count]) => (
          <Badge key={type} variant="secondary" className="text-[10px]">{type}: {count}</Badge>
        ))}
      </div>

      {/* Event list */}
      <Card>
        <CardContent className="pt-4">
          <ScrollArea className="h-[600px]">
            <div className="space-y-0">
              {data.events.map(e => (
                <EventRow key={e.id} e={e} />
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {data.resume?.snapshot && (
        <Collapsible>
          <Card>
            <CollapsibleTrigger className="w-full">
              <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-accent/50 transition-colors">
                <CardTitle className="text-sm">
                  Resume Snapshot ({data.resume.event_count} events, {data.resume.consumed ? "consumed" : "pending"})
                </CardTitle>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent>
                <ScrollArea className="max-h-96">
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono">
                    {data.resume.snapshot}
                  </pre>
                </ScrollArea>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}
    </div>
  );
}
