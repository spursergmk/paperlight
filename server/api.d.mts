// Type surface for the shared local API module (server/api.mjs).
// The implementation is plain ESM JavaScript because it is imported both by the
// Vite dev server (bundled by esbuild) and by the Electron main process at runtime.

import type { IncomingMessage, ServerResponse } from 'node:http'

export type NextFunction = (error?: unknown) => void
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void

export interface ApiConfigStatus {
  configured: boolean
  source: 'environment' | 'local-file' | null
  baseUrl: string
  protocol: 'responses' | 'chat-completions'
  csrfNonce: string
}

export interface PaperlightApi {
  middleware: Middleware
  csrfNonce: string
  configStatus: () => ApiConfigStatus
}

export declare const CONFIG_PATH: string
export declare const SENSE_PATH: string
export declare const QUERY_PATH: string
export declare const ANALYSIS_PATH: string
export declare const TRANSLATE_PATH: string
export declare const VAULT_CHAT_PATH: string
export declare const NOTE_PATH: string
export declare const DAILY_SUMMARY_PATH: string
export declare const EXPRESSION_EXPLORE_PATH: string
export declare const DEFAULT_API_BASE_URL: string
export declare const DEFAULT_MODEL: string

export declare function createPaperlightApi(options: {
  root: string
  csrfNonce?: string
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}): PaperlightApi

export declare function createStaticHandler(distDir: string): Middleware
export declare function localEnvPath(root: string): string
export declare class RequestError extends Error {
  constructor(status: number, message: string)
  status: number
}
