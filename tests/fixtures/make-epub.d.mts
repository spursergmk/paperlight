// Type surface for the EPUB fixture builder used by the tests and the smoke run.

export declare function createTestEpub(options?: {
  title?: string
  author?: string
  chapters?: string[]
}): Promise<Uint8Array>
