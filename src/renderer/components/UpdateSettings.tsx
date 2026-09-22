import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
  CheckCircle,
  Download,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import {
  sanitizeReleaseNotesForDisplay,
  transformReleaseNotesUrl,
} from "../utils/release-notes-markdown";
import { translate, useLanguage } from "../i18n";

interface VersionInfo {
  version: string;
  isDev: boolean;
  isGitRepo: boolean;
  isNpmGlobal: boolean;
  gitBranch?: string;
  gitCommit?: string;
}

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  updateMode: "git" | "npm" | "electron-updater";
}

interface UpdateProgress {
  phase:
    | "checking"
    | "downloading"
    | "extracting"
    | "installing"
    | "complete"
    | "error";
  percent?: number;
  message: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
}

function ReleaseNotesLink({
  href,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  if (!href) {
    return <>{children}</>;
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

function normalizeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

export function UpdateSettings({
  initialUpdateInfo,
}: {
  initialUpdateInfo?: UpdateInfo | null;
}) {
  useLanguage();
  const t = translate;
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(
    initialUpdateInfo ?? null,
  );
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [manualInstallerReady, setManualInstallerReady] = useState(false);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);

  useEffect(() => {
    if (initialUpdateInfo?.available) {
      setUpdateInfo(initialUpdateInfo);
      setError(null);
    }
  }, [initialUpdateInfo]);

  useEffect(() => {
    loadVersionInfo();

    const restoreUpdateStatus = async () => {
      try {
        const status = await window.electronAPI.getUpdateStatus?.();
        if (status?.progress) {
          setProgress(status.progress);
          setUpdating(status.progress.phase === "downloading");
          if (status.progress.phase === "error") {
            setError(status.progress.message);
          }
        }
        if (
          status?.ready &&
          (!initialUpdateInfo?.latestVersion ||
            status.latestVersion === initialUpdateInfo.latestVersion)
        ) {
          setUpdateReady(true);
          setManualInstallerReady(Boolean(status.manual));
          setDownloadPath(status.path ?? null);
          setUpdating(false);
        }
      } catch {
        // Browser preview and older packaged builds may not expose status yet.
      }
    };
    void restoreUpdateStatus();

    // Subscribe to update events
    const unsubProgress = window.electronAPI.onUpdateProgress((prog) => {
      setProgress(prog);
      if (prog.phase === "error") {
        setError(prog.message);
        setUpdating(false);
      }
    });

    const unsubDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
      setUpdateReady(true);
      setManualInstallerReady(Boolean(info?.manual));
      setDownloadPath(info?.path ?? null);
      setUpdating(false);
    });

    const unsubError = window.electronAPI.onUpdateError((err) => {
      setError(err.error);
      setUpdating(false);
    });

    return () => {
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, []);

  const loadVersionInfo = async () => {
    try {
      setLoading(true);
      const info = await window.electronAPI.getAppVersion();
      setVersionInfo(info);
    } catch (err: Any) {
      setError(normalizeUpdateError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCheckForUpdates = async () => {
    try {
      setChecking(true);
      setError(null);
      setUpdateInfo(null);
      const info = await window.electronAPI.checkForUpdates();
      setUpdateInfo(info);
    } catch (err: Any) {
      setError(normalizeUpdateError(err));
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadUpdate = async () => {
    if (!updateInfo) return;

    try {
      setUpdating(true);
      setError(null);
      await window.electronAPI.downloadUpdate(updateInfo);
    } catch (err: Any) {
      setError(normalizeUpdateError(err));
      setUpdating(false);
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await window.electronAPI.installUpdate();
    } catch (err: Any) {
      setError(normalizeUpdateError(err));
    }
  };

  const displayReleaseNotes = updateInfo?.releaseNotes
    ? sanitizeReleaseNotesForDisplay(updateInfo.releaseNotes)
    : "";

  if (loading) {
    return (
      <div className="settings-loading">
        {t("updates.loading", "Loading version info...")}
      </div>
    );
  }

  return (
    <div className="update-settings">
      <header className="update-page-header">
        <div className="update-page-header-icon" aria-hidden="true">
          <RefreshCw size={18} strokeWidth={2} />
        </div>
        <div className="update-page-header-copy">
          <span className="update-page-kicker">
            {t("updates.kicker", "Software updates")}
          </span>
          <h2>{t("updates.pageTitle", "Keep NeoWorker up to date")}</h2>
          <p>
            {t(
              "updates.pageDescription",
              "Check for the latest improvements and install them when ready.",
            )}
          </p>
        </div>
      </header>

      <div className="update-version-panel">
        <div className="update-panel-heading">
          <div>
            <span className="update-panel-eyebrow">
              {t("updates.currentVersion", "Current version")}
            </span>
            <div className="version-number">
              v{versionInfo?.version || t("updates.unknown", "Unknown")}
            </div>
          </div>
          <div className="update-version-state">
            <CheckCircle size={16} strokeWidth={2} />
            <span>{t("updates.installed", "Installed locally")}</span>
          </div>
        </div>
        <div className="version-info">
          {versionInfo?.isDev && (
            <span className="version-badge dev">
              {t("updates.developmentMode", "Development Mode")}
            </span>
          )}
          {versionInfo?.isNpmGlobal && (
            <span className="version-badge npm">
              {t("updates.installedViaNpm", "Installed via npm")}
            </span>
          )}
          {versionInfo?.isGitRepo && (
            <div className="git-info">
              <span className="git-branch">{versionInfo.gitBranch}</span>
              {versionInfo.gitCommit && (
                <span className="git-commit">@ {versionInfo.gitCommit}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <section className="update-check-panel">
        <div className="update-panel-icon" aria-hidden="true">
          <RefreshCw size={18} strokeWidth={2} />
        </div>
        <div className="update-panel-copy">
          <h3>{t("updates.check.title", "Check for updates")}</h3>
        <p className="settings-description">
          {versionInfo?.isNpmGlobal
            ? t("updates.check.npm", "Updates will be installed via npm.")
            : versionInfo?.isGitRepo
              ? t(
                  "updates.check.git",
                  "Updates will be pulled from GitHub and rebuilt automatically.",
                )
              : t(
                  "updates.check.auto",
                  "Updates will be downloaded and installed automatically.",
                )}
        </p>

          <p className="update-check-note">
            {t(
              "updates.check.note",
              "The app checks the official release channel and keeps your files untouched.",
            )}
          </p>
        </div>
        <div className="update-actions">
          <button
            className="button-primary update-check-button"
            onClick={handleCheckForUpdates}
            disabled={checking || updating}
          >
            {checking
              ? t("updates.checking", "Checking...")
              : t("updates.check.action", "Check for Updates")}
          </button>
        </div>

        {updateInfo && (
          <div
            className={`update-status ${updateInfo.available ? "available" : "up-to-date"}`}
          >
            {updateInfo.available ? (
              <>
                <div className="update-header">
                  <Download size={20} strokeWidth={2} />
                  <span>{t("updates.available", "Update Available!")}</span>
                </div>
                <div className="update-versions">
                  <span className="current">
                    {t("updates.current", "Current")}:{" "}
                    {updateInfo.currentVersion}
                  </span>
                  <span className="arrow">→</span>
                  <span className="latest">
                    {t("updates.latest", "Latest")}: {updateInfo.latestVersion}
                  </span>
                </div>
                {updateInfo.publishedAt && (
                  <div className="update-date">
                    {t("updates.released", "Released")}:{" "}
                    {new Date(updateInfo.publishedAt).toLocaleDateString()}
                  </div>
                )}
                {displayReleaseNotes && (
                  <div className="release-notes">
                    <h4>{t("updates.releaseNotes", "Release Notes")}</h4>
                    <div className="release-notes-content markdown-content">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        urlTransform={(url) =>
                          transformReleaseNotesUrl(url, updateInfo.releaseUrl)
                        }
                        components={{ a: ReleaseNotesLink }}
                      >
                        {displayReleaseNotes}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                {updateInfo.releaseUrl && (
                  <a
                    href={updateInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="release-link"
                  >
                    {t("updates.viewOnGithub", "View on GitHub")} →
                  </a>
                )}
                <div className="update-mode">
                  {t("updates.method", "Update method")}:{" "}
                  <strong>
                    {updateInfo.updateMode === "npm"
                      ? t("updates.method.npm", "npm update")
                      : updateInfo.updateMode === "git"
                        ? t("updates.method.git", "Git pull + rebuild")
                        : t("updates.method.auto", "Automatic download")}
                  </strong>
                </div>
              </>
            ) : (
              <div className="update-header up-to-date">
                <CheckCircle size={20} strokeWidth={2} />
                <span>{t("updates.upToDate", "You're up to date!")}</span>
              </div>
            )}
          </div>
        )}

        {progress && (
          <div className="update-progress">
            <div className="progress-message">{progress.message}</div>
            {progress.percent !== undefined && (
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {downloadPath && updateReady && (
          <div className="update-location">
            <span>{t("updates.downloadLocation", "Downloaded to")}</span>
            <code>{downloadPath}</code>
          </div>
        )}

        {error && (
          <div className="update-error">
            <XCircle size={16} strokeWidth={2} />
            {error}
          </div>
        )}

        {updateInfo?.available && !updating && !updateReady && (
          <button
            className="button-primary update-button"
            onClick={handleDownloadUpdate}
            disabled={updating}
          >
            {versionInfo?.isNpmGlobal
              ? t("updates.updateNowNpm", "Update Now (npm install)")
              : versionInfo?.isGitRepo
                ? t("updates.updateNowGit", "Update Now (Git Pull + Rebuild)")
                : t("updates.downloadInstall", "Download & Install Update")}
          </button>
        )}

        {updateReady && (
          <button
            className="button-primary update-button restart"
            onClick={handleInstallUpdate}
          >
            {manualInstallerReady
              ? t("updates.openInstaller", "Open Installer")
              : t("updates.restart", "Restart to Apply Update")}
          </button>
        )}
      </section>

      <section className="update-manual-panel">
        <div className="update-manual-heading">
          <div className="update-panel-icon update-panel-icon-muted" aria-hidden="true">
            <Terminal size={17} strokeWidth={2} />
          </div>
          <div>
            <h3>{t("updates.manual.title", "Manual update")}</h3>
            <span>{t("updates.manual.advanced", "For advanced users")}</span>
          </div>
          <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
        </div>
        <p className="settings-description">
          {t(
            versionInfo?.isNpmGlobal
              ? "updates.manual.description.command"
              : "updates.manual.description.commands",
            versionInfo?.isNpmGlobal
              ? "You can also manually update by running this command in the terminal:"
              : "You can also manually update by running these commands in the terminal:",
          )}
        </p>
        <div className="manual-update-commands">
          {versionInfo?.isNpmGlobal ? (
            <code>npm update -g neoworker</code>
          ) : (
            <code>
              git fetch origin{"\n"}
              git pull origin main{"\n"}
              npm install{"\n"}
              npm run build
            </code>
          )}
        </div>
        <p className="settings-hint">
          {t(
            "updates.manual.restartHint",
            "After updating, restart the application to apply changes.",
          )}
        </p>
      </section>
    </div>
  );
}
