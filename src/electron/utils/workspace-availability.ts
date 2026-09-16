import * as fs from "fs";
import * as path from "path";
import type {
  Workspace,
  WorkspaceAvailability,
} from "../../shared/types";

export const WORKSPACE_PATH_UNAVAILABLE_PREFIX =
  "WORKSPACE_PATH_UNAVAILABLE";

export interface WorkspaceAvailabilityResult {
  availability: WorkspaceAvailability;
  reason?: string;
}

function unavailable(
  availability: Exclude<WorkspaceAvailability, "available">,
  workspacePath: string,
): WorkspaceAvailabilityResult {
  const resolvedPath = path.resolve(workspacePath);
  const reason =
    availability === "missing"
      ? `Workspace folder no longer exists: ${resolvedPath}`
      : availability === "not_directory"
        ? `Workspace path is no longer a folder: ${resolvedPath}`
        : availability === "unreadable"
          ? `Workspace folder cannot be read: ${resolvedPath}`
          : `Workspace folder was recreated after registration and the original files are no longer present: ${resolvedPath}`;
  return { availability, reason };
}

export function inspectWorkspacePath(
  workspacePath: string,
): WorkspaceAvailabilityResult {
  const resolvedPath = path.resolve(workspacePath);
  try {
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return unavailable("not_directory", resolvedPath);
    }
    fs.accessSync(resolvedPath, fs.constants.R_OK);
    return { availability: "available" };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return unavailable(
      code === "ENOENT" ? "missing" : "unreadable",
      resolvedPath,
    );
  }
}

export function inspectWorkspace(
  workspace: Pick<Workspace, "path" | "createdAt" | "isTemp">,
): WorkspaceAvailabilityResult {
  const basic = inspectWorkspacePath(workspace.path);
  if (basic.availability !== "available" || workspace.isTemp) return basic;

  try {
    const stats = fs.statSync(workspace.path);
    const entries = fs.readdirSync(workspace.path);
    const containsOnlyNeoWorkerState =
      entries.length > 0 && entries.every((entry) => entry === ".neoworker");
    const recreatedAfterRegistration =
      Number.isFinite(stats.birthtimeMs) &&
      stats.birthtimeMs > workspace.createdAt + 5_000;
    if (containsOnlyNeoWorkerState && recreatedAfterRegistration) {
      return unavailable("recreated_empty", workspace.path);
    }
  } catch {
    return unavailable("unreadable", workspace.path);
  }

  return basic;
}

export function withWorkspaceAvailability(workspace: Workspace): Workspace {
  const result = inspectWorkspace(workspace);
  return {
    ...workspace,
    availability: result.availability,
    ...(result.reason ? { availabilityReason: result.reason } : {}),
  };
}

export function assertWorkspacePathAvailable(
  workspace: Pick<Workspace, "path" | "createdAt" | "isTemp">,
): void {
  const result = inspectWorkspace(workspace);
  if (result.availability === "available") return;
  throw new Error(
    `${WORKSPACE_PATH_UNAVAILABLE_PREFIX}:${result.availability}: ${result.reason}`,
  );
}

export function assertWorkspaceDirectoryPath(workspacePath: string): void {
  const result = inspectWorkspacePath(workspacePath);
  if (result.availability === "available") return;
  throw new Error(
    `${WORKSPACE_PATH_UNAVAILABLE_PREFIX}:${result.availability}: ${result.reason}`,
  );
}
