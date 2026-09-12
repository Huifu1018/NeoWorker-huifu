import { FileViewer } from "./FileViewer";

type DocumentAwareFileModalProps = {
  filePath: string;
  workspacePath?: string;
  onClose: () => void;
};

export function DocumentAwareFileModal({
  filePath,
  workspacePath,
  onClose,
}: DocumentAwareFileModalProps) {
  const lowerPath = filePath.toLowerCase();

  // Opening an attachment is a preview action. Keep the structured document
  // editor separate so it cannot replace the normal Word preview by accident.
  return (
    <FileViewer
      filePath={filePath}
      workspacePath={workspacePath}
      onClose={onClose}
      variant={lowerPath.endsWith(".pdf") ? "side-pane" : "modal"}
    />
  );
}
