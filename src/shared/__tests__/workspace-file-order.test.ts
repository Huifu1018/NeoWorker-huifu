import { describe, expect, it } from "vitest";
import { compareWorkspaceFilesNewestFirst, getWorkspaceFileCreationTime } from "../workspace-file-order";

describe("workspace file ordering", () => {
  const file = (name: string, createdAt?: number, modifiedAt?: number) => ({ name, path: name, createdAt, modifiedAt });

  it("puts the latest generated document first, not the latest edited one", () => {
    const files = [file("a-old.pptx", 100, 900), file("z-new.xlsx", 300, 300), file("m-middle.pdf", 200, 400)];
    expect(files.sort(compareWorkspaceFilesNewestFirst).map((item) => item.name)).toEqual(["z-new.xlsx", "m-middle.pdf", "a-old.pptx"]);
  });

  it("keeps folders first and uses stable name/path ordering for ties", () => {
    const files = [file("b.pdf", 100), file("a.pdf", 100), { ...file("folder", 1), isDirectory: true }];
    expect(files.sort(compareWorkspaceFilesNewestFirst).map((item) => item.name)).toEqual(["folder", "a.pdf", "b.pdf"]);
    expect([...files].reverse().sort(compareWorkspaceFilesNewestFirst)).toEqual(files);
  });

  it("falls back to modified time and puts unknown dates last", () => {
    const files = [file("unknown.pdf"), file("legacy.pdf", undefined, 200), file("invalid.pdf", NaN, 100)];
    expect(files.sort(compareWorkspaceFilesNewestFirst).map((item) => item.name)).toEqual(["legacy.pdf", "invalid.pdf", "unknown.pdf"]);
    expect(getWorkspaceFileCreationTime(file("zero", 0, 123))).toBe(123);
    expect(getWorkspaceFileCreationTime(file("invalid", Infinity, -1))).toBe(0);
  });
});
