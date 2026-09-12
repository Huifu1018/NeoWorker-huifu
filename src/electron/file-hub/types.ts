/**
 * File Hub types — unified file browsing across local, artifacts, and cloud.
 */

export type FileHubSource =
  | "local"
  | "artifacts"
  | "google_drive"
  | "onedrive"
  | "dropbox"
  | "box"
  | "sharepoint";

export interface UnifiedFile {
  id: string;
  name: string;
  path: string;
  source: FileHubSource;
  mimeType: string;
  size: number;
  modifiedAt: number;
  provider?: string;
  isDirectory?: boolean;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface FileHubSearchResult {
  file: UnifiedFile;
  snippet?: string;
  score?: number;
}

export interface FileHubListOptions {
  source: FileHubSource;
  workspaceId?: string;
  taskId?: string;
  path?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface FileHubArtifactQuery {
  taskId?: string;
  workspaceId?: string;
  limit?: number;
}

export interface FileHubServiceDeps {
  getWorkspacePath: (workspaceId: string) => string;
  getArtifacts: (query?: FileHubArtifactQuery) => Any[];
  /** Check which cloud connectors are configured */
  getConnectedSources: () => FileHubSource[];
  log?: (...args: unknown[]) => void;
}
