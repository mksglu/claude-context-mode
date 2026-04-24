import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Chunk } from "@/lib/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Search as SearchIcon, ChevronDown } from "lucide-react";

export const Route = createFileRoute("/search")({ component: SearchPage });

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Chunk[] | null>(null);
  const [loading, setLoading] = useState(false);

  const doSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      setResults(await api.search(query.trim()));
    } finally { setLoading(false); }
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-6">Search All Memory</h2>

      <div className="flex gap-2 mb-6">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && doSearch()}
          placeholder='Search across all knowledge bases (full words or partial text)...'
          className="font-mono text-sm"
        />
        <Button onClick={doSearch} disabled={loading} className="gap-2">
          <SearchIcon className="h-4 w-4" />
          Search
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Searching...</p>}

      {results && results.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No results for &ldquo;{query}&rdquo;</p>
            <p className="text-xs text-muted-foreground mt-1">Try different terms, FTS5 syntax (word1 OR word2), or paste partial text</p>
          </CardContent>
        </Card>
      )}

      {results && results.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground mb-4">{results.length} results</p>
          {results.map((r, i) => (
            <Collapsible key={i} defaultOpen={i < 3}>
              <Card>
                <CollapsibleTrigger className="w-full">
                  <CardHeader className="flex flex-row items-center justify-between py-3 cursor-pointer hover:bg-accent/50 transition-colors">
                    <span className="text-sm font-medium text-left flex-1 truncate">{r.title || "(untitled)"}</span>
                    <div className="flex items-center gap-2">
                      {r.dbHash && <Badge variant="outline" className="text-[10px]">{r.dbHash.slice(0, 8)}</Badge>}
                      <Badge variant={r.content_type === "code" ? "default" : "secondary"} className="text-[10px]">{r.content_type}</Badge>
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="pt-0">
                    <ScrollArea className="max-h-64">
                      <pre
                        className="text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono leading-relaxed"
                        dangerouslySetInnerHTML={{
                          __html: (r.highlighted ? esc(r.highlighted) : esc(r.content))
                            .replace(/«/g, '<mark class="bg-amber-500/20 text-foreground rounded px-0.5">')
                            .replace(/»/g, "</mark>"),
                        }}
                      />
                    </ScrollArea>
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          ))}
        </div>
      )}
    </div>
  );
}
