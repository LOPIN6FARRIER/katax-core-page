import axios from "axios";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { katax } from "katax-service-manager";

// ==================== TYPES ====================

interface DashboardRegistryHandle {
  stop: () => Promise<void>;
}

interface InitOptions {
  appName: string;
  version: string;
  port: string;
  intervalMs?: number;
}

// ==================== PROJECT ID PERSISTENCE ====================
// Stored in package.json under "katax.dashboardProjectId" so it only gets
// assigned once per project, then reused on every future start/deploy.

const PACKAGE_JSON_PATH = path.resolve(process.cwd(), "package.json");

function readProjectId(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"));
    return pkg.katax?.dashboardProjectId ?? null;
  } catch {
    return null;
  }
}

function saveProjectId(projectId: string): void {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  pkg.katax = { ...pkg.katax, dashboardProjectId: projectId };
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
}

// ==================== PAYLOAD ====================

function buildServicePayload(
  projectId: string | null,
  opts: InitOptions,
) {
  const mem = process.memoryUsage();
  return {
    ...(projectId ? { projectId } : {}),
    name: opts.appName,
    version: opts.version,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    pid: process.pid,
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
    },
    metadata: {
      port: Number(opts.port),
      url: katax.env("PRODUCTION_URL", ""),
      env: process.env.NODE_ENV ?? "unknown",
    },
    timestamp: Date.now(),
  };
}

// ==================== PUBLIC API ====================

/**
 * Registers this project with the api-dashboard registry over HTTP
 * (instead of writing directly to Redis), then keeps sending heartbeats.
 *
 * First run (no dashboardProjectId in package.json): calls /services/register,
 * persists the projectId the dashboard assigns.
 * Every run after that: skips the full register call, goes straight to heartbeat.
 */
export async function initDashboardRegistry(
  opts: InitOptions,
): Promise<DashboardRegistryHandle> {
  const baseUrl = katax.env("DASHBOARD_API_BASE_URL", "");
  const apiKey = katax.env("DASHBOARD_API_KEY", "");

  if (!baseUrl || !apiKey) {
    katax.logger.warn({
      message:
        "DASHBOARD_API_BASE_URL/DASHBOARD_API_KEY not set, skipping dashboard registry",
    });
    return { stop: async () => {} };
  }

  const client = axios.create({
    baseURL: baseUrl,
    headers: { "X-API-Key": apiKey },
    timeout: 5000,
  });

  let projectId = readProjectId();

  try {
    if (!projectId) {
      const { data } = await client.post(
        "/services/register",
        buildServicePayload(null, opts),
      );
      const newProjectId = data?.data?.projectId ?? null;
      if (newProjectId) {
        projectId = newProjectId;
        saveProjectId(newProjectId);
        katax.logger.info({
          message: "Registered with dashboard, projectId saved to package.json",
          projectId,
        });
      }
    } else {
      await client.post(
        "/services/heartbeat",
        buildServicePayload(projectId, opts),
      );
      katax.logger.info({
        message: "Dashboard registry: existing projectId confirmed",
        projectId,
      });
    }
  } catch (err) {
    katax.logger.warn({
      message: "Dashboard registry initial call failed",
      err: axios.isAxiosError(err) ? err.response?.data ?? err.message : err,
    });
  }

  // Record this version on every start (idempotent: dashboard just no-ops if
  // this exact projectId+version was already recorded, no duplicate rows).
  if (projectId) {
    try {
      await client.post("/services/version", {
        projectId,
        version: opts.version,
        environment: process.env.NODE_ENV ?? "unknown",
      });
    } catch (err) {
      katax.logger.warn({
        message: "Dashboard version report failed",
        err: axios.isAxiosError(err) ? err.response?.data ?? err.message : err,
      });
    }
  }

  const intervalMs = opts.intervalMs ?? 10000;
  const timer = setInterval(() => {
    void client
      .post("/services/heartbeat", buildServicePayload(projectId, opts))
      .then(({ data }) => {
        const newProjectId = data?.data?.projectId;
        if (newProjectId && newProjectId !== projectId) {
          projectId = newProjectId;
          saveProjectId(newProjectId);
        }
      })
      .catch((err) => {
        katax.logger.warn({
          message: "Dashboard heartbeat failed",
          err: axios.isAxiosError(err) ? err.response?.data ?? err.message : err,
        });
      });
  }, intervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      try {
        await client.post("/services/unregister", {
          ...(projectId ? { projectId } : {}),
          name: opts.appName,
          version: opts.version,
          hostname: os.hostname(),
          pid: process.pid,
          timestamp: Date.now(),
        });
      } catch (err) {
        katax.logger.warn({
          message: "Dashboard unregister failed",
          err: axios.isAxiosError(err) ? err.response?.data ?? err.message : err,
        });
      }
    },
  };
}
