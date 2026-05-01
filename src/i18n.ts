import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
  es: {
    "ctx.stats.title": "## estadísticas de context-mode (Pi)",
    "ctx.stats.session": "- Sesión: `{session}...`",
    "ctx.stats.events": "- Eventos capturados: {count}",
    "ctx.stats.compactions": "- Compactaciones: {count}",
    "ctx.stats.breakdown": "- Desglose de eventos:",
    "ctx.stats.age": "- Edad de la sesión: {minutes}m",
    "ctx.stats.unavailable": "estadísticas de context-mode no disponibles (error de la BD de sesión)",
    "ctx.noActiveSession": "context-mode: no hay sesión activa",
    "ctx.doctor.dbPath": "- Ruta de BD: `{path}`",
    "ctx.doctor.dbExists": "- La BD existe: {exists}",
    "ctx.doctor.sessionId": "- ID de sesión: `{session}`",
    "ctx.doctor.events": "- Eventos: {count}",
    "ctx.doctor.compactions": "- Compactaciones: {count}",
    "ctx.doctor.resume": "- Instantánea de reanudación: {status}",
    "ctx.doctor.dbError": "- Error de consulta de BD",
  },
  fr: {
    "ctx.stats.title": "## statistiques context-mode (Pi)",
    "ctx.stats.session": "- Session : `{session}...`",
    "ctx.stats.events": "- Événements capturés : {count}",
    "ctx.stats.compactions": "- Compactages : {count}",
    "ctx.stats.breakdown": "- Répartition des événements :",
    "ctx.stats.age": "- Âge de la session : {minutes}m",
    "ctx.stats.unavailable": "statistiques context-mode indisponibles (erreur de BD de session)",
    "ctx.noActiveSession": "context-mode : aucune session active",
    "ctx.doctor.dbPath": "- Chemin BD : `{path}`",
    "ctx.doctor.dbExists": "- BD présente : {exists}",
    "ctx.doctor.sessionId": "- ID de session : `{session}`",
    "ctx.doctor.events": "- Événements : {count}",
    "ctx.doctor.compactions": "- Compactages : {count}",
    "ctx.doctor.resume": "- Instantané de reprise : {status}",
    "ctx.doctor.dbError": "- Erreur de requête BD",
  },
  "pt-BR": {
    "ctx.stats.title": "## estatísticas do context-mode (Pi)",
    "ctx.stats.session": "- Sessão: `{session}...`",
    "ctx.stats.events": "- Eventos capturados: {count}",
    "ctx.stats.compactions": "- Compactações: {count}",
    "ctx.stats.breakdown": "- Detalhamento de eventos:",
    "ctx.stats.age": "- Idade da sessão: {minutes}m",
    "ctx.stats.unavailable": "estatísticas do context-mode indisponíveis (erro no BD da sessão)",
    "ctx.noActiveSession": "context-mode: nenhuma sessão ativa",
    "ctx.doctor.dbPath": "- Caminho do BD: `{path}`",
    "ctx.doctor.dbExists": "- BD existe: {exists}",
    "ctx.doctor.sessionId": "- ID da sessão: `{session}`",
    "ctx.doctor.events": "- Eventos: {count}",
    "ctx.doctor.compactions": "- Compactações: {count}",
    "ctx.doctor.resume": "- Snapshot de retomada: {status}",
    "ctx.doctor.dbError": "- Erro de consulta ao BD",
  },
};

let currentLocale: Locale = "en";

export function initI18n(pi: ExtensionAPI): void {
  pi.events?.emit?.("pi-core/i18n/registerBundle", {
    namespace: "context-mode",
    defaultLocale: "en",
    locales: translations,
  });

  pi.events?.emit?.("pi-core/i18n/requestApi", {
    onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
      const next = api.getLocale?.();
      if (isLocale(next)) currentLocale = next;
      api.onLocaleChange?.((locale) => {
        if (isLocale(locale)) currentLocale = locale;
      });
    },
  });
}

export function t(key: string, fallback: string, params: Params = {}): string {
  const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
  return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
