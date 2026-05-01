type Params = Record<string, string | number | boolean>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
  return translate(key, fallback, params);
}

const bundles = [
  {
    locale: "ja",
    namespace: "context-mode",
    messages: {
      "block.inlineHttp": "インライン HTTP クライアントではなく context-mode MCP ツール（execute、fetch_and_index）を使ってください。生の curl/wget/fetch 出力はコンテキストウィンドウを圧迫します。",
      "cmd.stats.description": "context-mode のセッション統計を表示",
      "cmd.doctor.description": "context-mode の診断を実行",
      "stats.title": "## context-mode 統計（Pi）",
      "stats.session": "- セッション: `{session}`",
      "stats.events": "- 取得イベント数: {count}",
      "stats.compactions": "- 圧縮回数: {count}",
      "stats.breakdown": "- イベント内訳:",
      "stats.age": "- セッション経過時間: {minutes}分",
      "stats.unavailable": "context-mode 統計を利用できません（セッション DB エラー）",
      "stats.noSession": "context-mode: アクティブなセッションがありません",
      "doctor.title": "## ctx-doctor（Pi）",
      "doctor.dbPath": "- DB パス: `{path}`",
      "doctor.dbExists": "- DB あり: {exists}",
      "doctor.sessionId": "- セッション ID: `{session}`",
      "doctor.pluginRoot": "- プラグインルート: `{path}`",
      "doctor.projectDir": "- プロジェクトディレクトリ: `{path}`",
      "doctor.events": "- イベント: {count}",
      "doctor.compactions": "- 圧縮回数: {count}",
      "doctor.resume": "- 再開スナップショット: {state}",
      "doctor.dbQueryError": "- DB クエリエラー",
      "state.none": "なし",
      "state.consumed": "消費済み",
      "state.available": "利用可能",
    },
  },
  {
    locale: "zh-CN",
    namespace: "context-mode",
    messages: {
      "block.inlineHttp": "请使用 context-mode MCP 工具（execute、fetch_and_index），不要使用内联 HTTP 客户端。原始 curl/wget/fetch 输出会淹没上下文窗口。",
      "cmd.stats.description": "显示 context-mode 会话统计",
      "cmd.doctor.description": "运行 context-mode 诊断",
      "stats.title": "## context-mode 统计（Pi）",
      "stats.session": "- 会话: `{session}`",
      "stats.events": "- 已捕获事件: {count}",
      "stats.compactions": "- 压缩次数: {count}",
      "stats.breakdown": "- 事件分类:",
      "stats.age": "- 会话时长: {minutes} 分钟",
      "stats.unavailable": "context-mode 统计不可用（会话 DB 错误）",
      "stats.noSession": "context-mode: 没有活动会话",
      "doctor.title": "## ctx-doctor（Pi）",
      "doctor.dbPath": "- DB 路径: `{path}`",
      "doctor.dbExists": "- DB 存在: {exists}",
      "doctor.sessionId": "- 会话 ID: `{session}`",
      "doctor.pluginRoot": "- 插件根目录: `{path}`",
      "doctor.projectDir": "- 项目目录: `{path}`",
      "doctor.events": "- 事件: {count}",
      "doctor.compactions": "- 压缩次数: {count}",
      "doctor.resume": "- 恢复快照: {state}",
      "doctor.dbQueryError": "- DB 查询错误",
      "state.none": "无",
      "state.consumed": "已消耗",
      "state.available": "可用",
    },
  },
  {
    locale: "es",
    namespace: "context-mode",
    messages: {
      "block.inlineHttp": "Usa las herramientas MCP de context-mode (execute, fetch_and_index) en lugar de clientes HTTP inline. La salida cruda de curl/wget/fetch llena la ventana de contexto.",
      "cmd.stats.description": "Mostrar estadísticas de sesión de context-mode",
      "cmd.doctor.description": "Ejecutar diagnósticos de context-mode",
      "stats.title": "## estadísticas de context-mode (Pi)",
      "stats.session": "- Sesión: `{session}`",
      "stats.events": "- Eventos capturados: {count}",
      "stats.compactions": "- Compactaciones: {count}",
      "stats.breakdown": "- Desglose de eventos:",
      "stats.age": "- Edad de la sesión: {minutes}m",
      "stats.unavailable": "estadísticas de context-mode no disponibles (error de DB de sesión)",
      "stats.noSession": "context-mode: no hay sesión activa",
      "doctor.title": "## ctx-doctor (Pi)",
      "doctor.dbPath": "- Ruta de DB: `{path}`",
      "doctor.dbExists": "- DB existe: {exists}",
      "doctor.sessionId": "- ID de sesión: `{session}`",
      "doctor.pluginRoot": "- Raíz del plugin: `{path}`",
      "doctor.projectDir": "- Directorio del proyecto: `{path}`",
      "doctor.events": "- Eventos: {count}",
      "doctor.compactions": "- Compactaciones: {count}",
      "doctor.resume": "- Snapshot de reanudación: {state}",
      "doctor.dbQueryError": "- Error de consulta de DB",
      "state.none": "ninguno",
      "state.consumed": "consumido",
      "state.available": "disponible",
    },
  },
];

export function initI18n(pi: any): void {
  const events = pi?.events;
  if (!events) return;
  for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
  events.emit("pi-core/i18n/requestApi", {
    namespace: "context-mode",
    callback(api: { t?: Translate } | undefined) {
      if (typeof api?.t === "function") translate = api.t;
    },
  });
}
