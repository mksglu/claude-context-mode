import { type RuntimeMap, type Language } from "./runtime.js";
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}
interface ExecuteOptions {
    language: Language;
    code: string;
    timeout?: number;
}
interface ExecuteFileOptions extends ExecuteOptions {
    path: string;
}
export declare class PolyglotExecutor {
    #private;
    constructor(opts?: {
        maxOutputBytes?: number;
        projectRoot?: string;
        runtimes?: RuntimeMap;
    });
    get runtimes(): RuntimeMap;
    execute(opts: ExecuteOptions): Promise<ExecResult>;
    executeFile(opts: ExecuteFileOptions): Promise<ExecResult>;
}
export {};
