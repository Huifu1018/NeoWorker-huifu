type TimedWorkspaceFile = {
  name: string;
  path: string;
  createdAt?: number;
  modifiedAt?: number;
  isDirectory?: boolean;
};

export function getWorkspaceFileCreationTime(file: TimedWorkspaceFile): number {
  for (const value of [file.createdAt, file.modifiedAt]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function compareWorkspaceFilesNewestFirst(a: TimedWorkspaceFile, b: TimedWorkspaceFile): number {
  if (Boolean(a.isDirectory) !== Boolean(b.isDirectory)) return a.isDirectory ? -1 : 1;
  if (!a.isDirectory) {
    const difference = getWorkspaceFileCreationTime(b) - getWorkspaceFileCreationTime(a);
    if (difference) return difference;
  }
  return a.name.localeCompare(b.name, "zh-CN") || a.path.localeCompare(b.path, "zh-CN");
}
