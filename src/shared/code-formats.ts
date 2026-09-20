export const CODE_ARTIFACT_EXTENSIONS = [
  "py", "pyw", "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "java",
  "go", "rs", "sql", "sh", "bash", "ps1", "rb", "php", "c", "h", "cpp", "cs", "swift",
] as const;

export function isCodeArtifactFile(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() || "";
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return CODE_ARTIFACT_EXTENSIONS.some(candidate => candidate === extension);
}
