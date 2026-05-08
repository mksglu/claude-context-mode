import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type ContentDB } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { timeAgo, dateGroup, parseSourceLabel } from "@/components/analytics";
import { Database, Layers, Clock, Trash2, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/knowledge")({ component: KnowledgeBase });

interface GroupedSources {
  label: string;
  sources: { source: ContentDB["sources"][0]; dbHash: string }[];
  totalChunks: number;
}

function KnowledgeBase() {
  const [dbs, setDbs] = useState<ContentDB[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.content().then(d => { setDbs(d); setLoading(false); }); }, []);

  const handleDelete = async (e: React.MouseEvent, dbHash: string, sourceId: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this source and all its chunks?")) return;
    await api.deleteSource(dbHash, sourceId);
    api.content().then(setDbs);
  };

  if (loading) return <p className="text-muted-foreground animate-pulse">Loading knowledge base...</p>;

  const nonEmpty = dbs.filter(db => db.sourceCount > 0);

  // Compute KPI values
  const totalSources = nonEmpty.reduce((a, db) => a + db.sourceCount, 0);
  const totalChunks = nonEmpty.reduce((a, db) => a + db.chunkCount, 0);

  // Find freshest indexed_at across all sources
  let freshestDate: string | null = null;
  for (const db of nonEmpty) {
    for (const s of db.sources) {
      if (s.indexedAt && (!freshestDate || s.indexedAt > freshestDate)) {
        freshestDate = s.indexedAt;
      }
    }
  }

  // Flatten all sources with their dbHash, then group by date
  const allSources: { source: ContentDB["sources"][0]; dbHash: string }[] = [];
  for (const db of nonEmpty) {
    for (const s of db.sources) {
      allSources.push({ source: s, dbHash: db.hash });
    }
  }
  // Sort by indexedAt descending
  allSources.sort((a, b) => (b.source.indexedAt || "").localeCompare(a.source.indexedAt || ""));

  // Group by date
  const groupOrder = ["Today", "Yesterday", "This Week", "Older"];
  const groupMap = new Map<string, GroupedSources>();
  for (const g of groupOrder) groupMap.set(g, { label: g, sources: [], totalChunks: 0 });

  for (const item of allSources) {
    const g = dateGroup(item.source.indexedAt);
    const group = groupMap.get(g)!;
    group.sources.push(item);
    group.totalChunks += item.source.chunks;
  }

  const groups = groupOrder.map(g => groupMap.get(g)!).filter(g => g.sources.length > 0);

  if (nonEmpty.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold">Knowledge Base</h2>
          <p className="text-sm text-muted-foreground mt-1">No indexed content yet</p>
        </div>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Use <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">ctx_index</code> or <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">ctx_fetch_and_index</code> to add content.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Knowledge Base</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {nonEmpty.length} database{nonEmpty.length > 1 ? "s" : ""} with indexed content
        </p>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Sources</CardTitle>
            <Database className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalSources}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">across {nonEmpty.length} db{nonEmpty.length > 1 ? "s" : ""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Chunks</CardTitle>
            <Layers className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalChunks}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{totalSources > 0 ? `~${Math.round(totalChunks / totalSources)} per source` : "no sources"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Freshness</CardTitle>
            <Clock className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{timeAgo(freshestDate)}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">last indexed</p>
          </CardContent>
        </Card>
      </div>

      {/* Source groups by date */}
      {groups.map(group => (
        <div key={group.label}>
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h3>
            <Badge variant="secondary" className="text-[10px]">{group.sources.length} source{group.sources.length > 1 ? "s" : ""}</Badge>
            <Badge variant="outline" className="text-[10px]">{group.totalChunks} chunks</Badge>
          </div>
          <div className="grid gap-2">
            {group.sources.map(({ source: s, dbHash }) => {
              const labels = parseSourceLabel(s.label);
              return (
                <Link
                  key={`${dbHash}-${s.id}`}
                  to="/knowledge/$dbHash/$sourceId"
                  params={{ dbHash, sourceId: String(s.id) }}
                  className="block group"
                >
                  <Card className="transition-colors hover:border-primary/30">
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        {/* Source labels as badges */}
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap gap-1.5 mb-1">
                            {labels.map((lbl, i) => (
                              <Badge key={i} variant="secondary" className="text-[10px] font-mono max-w-[200px] truncate">
                                {lbl}
                              </Badge>
                            ))}
                            {parseSourceLabel(s.label).length < s.label.split(",").length && (
                              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                +{s.label.split(",").length - 3} more
                              </Badge>
                            )}
                          </div>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <span className="text-[10px] text-muted-foreground font-mono block truncate max-w-[400px] text-left">
                                  {s.label}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-lg">
                                <span className="font-mono text-xs break-all">{s.label}</span>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>

                        {/* Chunk counts */}
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary" className="text-[10px] tabular-nums">
                            {s.chunks} chunk{s.chunks !== 1 ? "s" : ""}
                          </Badge>
                          {s.codeChunks > 0 && (
                            <Badge variant="outline" className="text-[10px] tabular-nums text-cyan-500 border-cyan-500/30">
                              {s.codeChunks} code
                            </Badge>
                          )}
                        </div>

                        {/* Time ago */}
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 min-w-[50px] text-right">
                          {timeAgo(s.indexedAt)}
                        </span>

                        {/* Delete button */}
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={(e) => handleDelete(e, dbHash, s.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>

                        <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
