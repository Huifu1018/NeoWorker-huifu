import { ArrowUpRight, FolderOpen } from "lucide-react";
import { translate, useLanguage } from "../i18n";
import { ArtifactFileTypeIcon } from "./ArtifactFileTypeIcon";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton";

export function CodeArtifactCard({ filePath, workspacePath, onOpenViewer }: {
  filePath: string;
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
}) {
  useLanguage();
  const name = filePath.split(/[\\/]/).pop() || filePath;
  const format = name.split(".").pop()?.toUpperCase() || "Code";
  // Always use the in-app source viewer. Opening a script with the OS default
  // application can execute it on Windows, which is not a preview action.
  const preview = () => onOpenViewer?.(filePath);
  return (
    <div className="document-artifact-card code-artifact-card">
      <ArtifactFileTypeIcon filePath={filePath} className="document-artifact-icon" />
      <button type="button" className="document-artifact-file" title={name} onClick={preview} disabled={!onOpenViewer}>
        <span className="document-artifact-name">{name}</span>
        <span className="document-artifact-meta">{format}</span>
      </button>
      <div className="document-artifact-actions">
        <button type="button" className="document-artifact-open" onClick={preview} disabled={!onOpenViewer}>
          <ArrowUpRight size={18} />
          <span>{translate("common.open", "Open")}</span>
        </button>
        <button type="button" className="document-artifact-menu-btn"
          title={translate("common.openInFolder", "Open in folder")}
          aria-label={translate("common.openInFolder", "Open in folder")}
          onClick={() => { void window.electronAPI.showInFinder(filePath, workspacePath); }}>
          <FolderOpen size={18} />
        </button>
        <ArtifactDownloadButton filePath={filePath} workspacePath={workspacePath} />
      </div>
    </div>
  );
}
