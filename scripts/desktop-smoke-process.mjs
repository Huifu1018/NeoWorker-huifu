// Only use with a POSIX child spawned with detached: true. That gives the
// probe its own process group, without touching other installed app instances.
export async function stopSmokeProcessGroup(child, graceMs = 2_000) {
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const closed = new Promise((resolve) => {
    const timer = setTimeout(finish, graceMs);
    function finish() {
      clearTimeout(timer);
      child.removeListener("close", finish);
      resolve();
    }
    child.once("close", finish);
  });
  try {
    signalGroup("SIGTERM");
    await closed;
    // The Electron parent can exit while a helper still owns its stdio pipes.
    // Kill the probe's remaining helpers even if the parent has already exited.
    signalGroup("SIGKILL");
  } finally {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}
