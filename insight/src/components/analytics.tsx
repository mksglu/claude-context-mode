import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";

const COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];
export { COLORS };

// ── Big number stat card ──
export function Stat({ label, value, sub, icon: Icon, color }: {
  label: string; value: string | number; sub: string; icon: LucideIcon; color: string;
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

// ── Mini number ──
export function Mini({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold tabular-nums ${color || ""}`}>{value}</div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
    </div>
  );
}

// ── Ratio bar ──
export function RatioBar({ items }: { items: { label: string; value: number; color: string }[] }) {
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

// ── Relative time helper ──
export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ── Date group label ──
export function dateGroup(dateStr: string | null | undefined): string {
  if (!dateStr) return "Older";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Older";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (target >= today) return "Today";
  if (target >= yesterday) return "Yesterday";
  if (target >= weekAgo) return "This Week";
  return "Older";
}

// ── Parse source label into badges ──
export function parseSourceLabel(label: string): string[] {
  let cleaned = label;
  if (cleaned.startsWith("batch:")) cleaned = cleaned.slice(6);
  const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
  return parts.slice(0, 3);
}

// ── Duration formatter ──
export function formatDuration(mins: number): string {
  if (mins < 1) return "<1m";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
