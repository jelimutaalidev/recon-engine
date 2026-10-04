declare module 'solc' {
  export interface SolcImportResult {
    contents?: string;
    error?: string;
  }

  export type SolcImportCallback = (path: string) => SolcImportResult;

  export interface SolcModule {
    version(): string;
    compile(input: string, options?: { import?: SolcImportCallback }): string;
    setupMethods(soljson: unknown): SolcModule;
    loadRemoteVersion(
      version: string,
      callback: (error: Error | null, soljson?: unknown) => void,
    ): void;
  }

  const solc: SolcModule;
  export default solc;
}
