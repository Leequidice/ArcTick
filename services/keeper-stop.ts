import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const pidFile = resolve(process.env.KEEPER_PID_FILE?.trim() || "run/keeper.pid");
if (!existsSync(pidFile)) {
  console.log("keeper not running (no PID file)");
  process.exit(0);
}

const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
if (!Number.isInteger(pid) || pid <= 0) {
  unlinkSync(pidFile);
  throw new Error("Removed invalid keeper PID file.");
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`keeper stop requested for PID ${pid}`);
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code === "ESRCH") {
    unlinkSync(pidFile);
    console.log(`removed stale keeper PID file for PID ${pid}`);
  } else {
    throw error;
  }
}
