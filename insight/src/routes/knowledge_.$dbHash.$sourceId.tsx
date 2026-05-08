import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type Chunk } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RatioBar, COLORS } from "@/components/analytics";
import { ArrowLeft, ChevronDown, Layers, Code, FileText } from "lucide-react";

export const Route = createFileRoute("/knowledge_/$dbHash/$sourceId")({ component: ChunkView });

function ChunkView() {
  const { dbHash, sourceId } = Route.useParams();
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.chunks(dbHash, Number(sourceId)).then(c => { setChunks(c); setLoading(false); });
  }, [dbHash, sourceId]);

  if (loading) return <p className="text-muted-foreground animate-pulse">Loading chunks...</p>;

  const sourceLabel = chunks[0]?.label || dbHash;

  // Compute stats
  const totalChunks = chunks.length;
  const codeChunks = chunks.filter(c => c.content_type === "code").length;
  const textChunks = totalChunks - codeChunks;

  // Content type breakdown
  const typeCounts: Record<string, number> = {};
  chunks.forEach(c => { typeCounts[c.content_type] = (typeCounts[c.content_type] || 0) + 1; });
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);

  // Average content length
  const avgLen = totalChunks > 0
    ? Math.round(chunks.reduce((a, c) => a + (c.content?.length || 0), 0) / totalChunks)
    : 0;

  return (
    <div className="space-y-6">
      <Link to="/knowledge" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Knowledge Base
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-2xl font-semibold">Source Detail</h2>
          <Badge variant="outline">{dbHash.slice(0, 8)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground font-mono break-all">{sourceLabel}</p>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Chunks</CardTitle>
            <Layers className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalChunks}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">~{avgLen} chars avg</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Code</CardTitle>
            <Code className="h-4 w-4 text-cyan-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{codeChunks}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{totalChunks > 0 ? `${Math.round(100 * codeChunks / totalChunks)}% of total` : "none"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Text</CardTitle>
            <FileText className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{textChunks}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{totalChunks > 0 ? `${Math.round(100 * textChunks / totalChunks)}% of total` : "none"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Content type ratio bar */}
      {typeEntries.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Content Types</CardTitle>
          </CardHeader>
          <CardContent>
            <RatioBar items={typeEntries.map(([type, count], i) => ({
              label: type, value: count, color: type === "code" ? "#06b6d4" : COLORS[i % COLORS.length],
            }))} />
          </CardContent>
        </Card>
      )}

      {/* Chunk list */}
      <div className="space-y-2">
        {chunks.map((chunk, i) => (
          <Collapsible key={i}>
            <Card>
              <CollapsibleTrigger className="w-full">
                <CardHeader className="flex flex-row items-center justify-between py-3 cursor-pointer hover:bg-accent/50 transition-colors">
                  <span className="text-sm font-medium text-left flex-1 truncate">{chunk.title || "(untitled)"}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant={chunk.content_type === "code" ? "default" : "secondary"} className="text-[10px]">
                      {chunk.content_type}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] tabular-nums text-muted-foreground">
                      {chunk.content?.length || 0} chars
                    </Badge>
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="max-h-80 overflow-y-auto rounded-md border border-border/50 bg-background/50 p-3">
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono leading-relaxed">
                      {chunk.content}
                    </pre>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ))}
      </div>
    </div>
  );
}
