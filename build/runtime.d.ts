export type Language = "javascript" | "typescript" | "python" | "shell" | "ruby" | "go" | "rust" | "php" | "perl" | "r";
export interface RuntimeInfo {
    command: string;
    available: boolean;
    version: string;
    preferred: boolean;
}
export interface RuntimeMap {
    javascript: string;
    typescript: string | null;
    python: string | null;
    shell: string;
    ruby: string | null;
    go: string | null;
    rust: string | null;
    php: string | null;
    perl: string | null;
    r: string | null;
}
export declare function detectRuntimes(): RuntimeMap;
export declare function hasBunRuntime(): boolean;
export declare function getRuntimeSummary(runtimes: RuntimeMap): string;
export declare function getAvailableLanguages(runtimes: RuntimeMap): Language[];
export declare function buildCommand(runtimes: RuntimeMap, language: Language, filePath: string): string[];
