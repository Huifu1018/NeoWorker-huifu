import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../shared/types";
import {
  assertWorkspacePathAvailable,
  inspectWorkspace,
  inspectWorkspacePath,
} from "../workspace-availability";

const createdPaths: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-workspace-availability-"));
  createdPaths.push(dir);
  return dir;
}

function workspaceAt(workspacePath: string, createdAt = Date.now()): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    path: workspacePath,
    createdAt,
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe("workspace availability", () => {
  it("reports a missing workspace path", async () => {
    const parent = await createTempDir();
    const missingPath = path.join(parent, "missing");

    expect(inspectWorkspacePath(missingPath).availability).toBe("missing");
    expect(() => assertWorkspacePathAvailable(workspaceAt(missingPath))).toThrow(
      "WORKSPACE_PATH_UNAVAILABLE:missing",
    );
  });

  it("reports a regular file instead of a folder", async () => {
    const parent = await createTempDir();
    const filePath = path.join(parent, "workspace.txt");
    await fs.writeFile(filePath, "not a directory", "utf8");

    expect(inspectWorkspacePath(filePath).availability).toBe("not_directory");
  });

  it("detects a recreated shell containing only NeoWorker state", async () => {
    const workspacePath = await createTempDir();
    await fs.mkdir(path.join(workspacePath, ".neoworker"));

    expect(
      inspectWorkspace(workspaceAt(workspacePath, Date.now() - 60_000)).availability,
    ).toBe("recreated_empty");
  });

  it("accepts the original readable workspace folder", async () => {
    const workspacePath = await createTempDir();
    await fs.writeFile(path.join(workspacePath, "notes.txt"), "ready", "utf8");

    expect(inspectWorkspace(workspaceAt(workspacePath)).availability).toBe(
      "available",
    );
  });
});
