import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { KernelIntegrationCaseResult } from "../evals/kernel/integration/redis-matrix.js";
import type {
  KernelPostgresEnvironment,
  KernelRedisEnvironment
} from "../evals/kernel/integration/environment.js";
import {
  createKernelIntegrationReport,
  writeKernelIntegrationReport
} from "../evals/kernel/integration/report.js";

export interface WorkerSuccess {
  type: "success";
  dependencyVersions: {
    redis: string;
    postgres: string;
    pgvector: string;
  };
  results: KernelIntegrationCaseResult[];
}

export interface WorkerFailure {
  type: "failure";
  failureCode: "kernel_integration_worker_failed";
}

type WorkerMessage = WorkerSuccess | WorkerFailure;

export async function runKernelIntegrationCli(): Promise<0 | 1 | 2> {
  const projectName = `kernel-v1-${process.pid}-${randomBytes(4).toString("hex")}`;
  const composeFile = fileURLToPath(
    new URL("../../compose.kernel-integration.yml", import.meta.url)
  );
  const dockerCommand = process.env.KERNEL_DOCKER_COMMAND?.trim() || "docker";
  const reservations = await reserveLoopbackPorts(2).catch(() => undefined);
  if (!reservations) {
    console.error("kernel_integration_port_reservation_failed");
    return 2;
  }

  const [redisPort, postgresPort] = reservations.map((entry) => entry.port);
  const composeEnvironment = {
    ...process.env,
    KERNEL_REDIS_PORT: String(redisPort),
    KERNEL_POSTGRES_PORT: String(postgresPort)
  };
  let composeStarted = false;
  let workerMessage: WorkerMessage | undefined;
  let cleanupPassed = false;

  try {
    await runCommand(dockerCommand, ["compose", "version"]);
    await Promise.all(reservations.map(async (entry) => entry.release()));
    await runCommand(
      dockerCommand,
      [
        "compose",
        "-f",
        composeFile,
        "-p",
        projectName,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "90"
      ],
      composeEnvironment
    );
    composeStarted = true;
    workerMessage = await runMatrixWorker({
      ...composeEnvironment,
      KERNEL_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      KERNEL_POSTGRES_URL: `postgresql://kernel:kernel@127.0.0.1:${postgresPort}/kernel`,
      KERNEL_COMPOSE_FILE: composeFile,
      KERNEL_COMPOSE_PROJECT: projectName,
      KERNEL_DOCKER_COMMAND: dockerCommand
    });
  } catch {
    workerMessage = { type: "failure", failureCode: "kernel_integration_worker_failed" };
  } finally {
    await Promise.allSettled(reservations.map(async (entry) => entry.release()));
    try {
      await runCommand(
        dockerCommand,
        ["compose", "-f", composeFile, "-p", projectName, "down", "--volumes", "--remove-orphans"],
        composeEnvironment
      );
      cleanupPassed = true;
    } catch {
      cleanupPassed = false;
    }
  }

  if (!workerMessage || workerMessage.type === "failure") {
    console.error(
      composeStarted
        ? "kernel_integration_worker_failed"
        : "kernel_integration_compose_start_failed"
    );
    if (!cleanupPassed) console.error("kernel_integration_compose_cleanup_failed");
    return 2;
  }

  const results: KernelIntegrationCaseResult[] = [
    ...workerMessage.results,
    {
      caseId: "harness/compose-cleanup",
      boundary: "deployment_configuration",
      passed: cleanupPassed,
      ...(cleanupPassed ? {} : { failureCode: "compose_cleanup_failed" })
    }
  ];
  const report = createKernelIntegrationReport({
    generatedAt: new Date().toISOString(),
    dependencyVersions: workerMessage.dependencyVersions,
    results
  });
  await writeKernelIntegrationReport(report);
  console.log(
    `Kernel v1 integration: ${report.passed ? "PASS" : "FAIL"} cases=${report.results.length}`
  );
  for (const result of report.results) {
    console.log(`${result.caseId}: ${result.passed ? "PASS" : `FAIL ${result.failureCode}`}`);
  }
  return report.passed ? 0 : 1;
}

async function runMatrixWorker(environment: NodeJS.ProcessEnv): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--worker"], {
      env: environment,
      execArgv: process.execArgv,
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    let message: WorkerMessage | undefined;
    child.on("message", (candidate: unknown) => {
      if (isWorkerMessage(candidate)) message = candidate;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!message) {
        reject(new Error("kernel_integration_worker_no_result"));
        return;
      }
      try {
        resolve(resolveKernelWorkerExit(message, code));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function resolveKernelWorkerExit(
  message: WorkerMessage,
  exitCode: number | null
): WorkerMessage {
  if (message.type === "failure") return message;
  const expectedExitCode = message.results.every((result) => result.passed) ? 0 : 1;
  if (exitCode !== expectedExitCode) {
    throw new Error("kernel_integration_worker_exit_failed");
  }
  return message;
}

async function runMatrixWorkerMain(): Promise<void> {
  let redisEnvironment: KernelRedisEnvironment | undefined;
  let postgresEnvironment: KernelPostgresEnvironment | undefined;
  try {
    await runIntegrationContractTests();
    const { createKernelPostgresEnvironment, createKernelRedisEnvironment } =
      await import("../evals/kernel/integration/environment.js");
    const {
      prepareRedisServerRestartState,
      runRedisIntegrationMatrix,
      verifyRedisAofPolicy,
      verifyRedisServerRestartState
    } = await import("../evals/kernel/integration/redis-matrix.js");
    const { runPostgresIntegrationMatrix } =
      await import("../evals/kernel/integration/postgres-matrix.js");
    redisEnvironment = await createKernelRedisEnvironment();
    postgresEnvironment = await createKernelPostgresEnvironment();
    const dependencyVersions = await readDependencyVersions(redisEnvironment, postgresEnvironment);
    const results = await runRedisIntegrationMatrix(redisEnvironment);
    results.push(await verifyRedisAofPolicy(redisEnvironment.clients[0]));
    await prepareRedisServerRestartState(redisEnvironment);
    await redisEnvironment.disconnectReplicas();
    await restartOwnedRedis();
    await redisEnvironment.reconnectReplicas();
    results.push(...(await verifyRedisServerRestartState(redisEnvironment)));
    results.push(...(await runPostgresIntegrationMatrix(postgresEnvironment)));

    const cleanup = await Promise.allSettled([
      redisEnvironment.cleanup(),
      postgresEnvironment.cleanup()
    ]);
    redisEnvironment = undefined;
    postgresEnvironment = undefined;
    const cleanupPassed = cleanup.every((entry) => entry.status === "fulfilled");
    results.push({
      caseId: "harness/namespace-cleanup",
      boundary: "deployment_configuration",
      passed: cleanupPassed,
      ...(cleanupPassed ? {} : { failureCode: "namespace_cleanup_failed" })
    });
    sendWorkerMessage({ type: "success", dependencyVersions, results });
    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
  } catch {
    await Promise.allSettled([
      redisEnvironment?.cleanup() ?? Promise.resolve(),
      postgresEnvironment?.cleanup() ?? Promise.resolve()
    ]);
    sendWorkerMessage({ type: "failure", failureCode: "kernel_integration_worker_failed" });
    process.exitCode = 2;
  }
}

async function runIntegrationContractTests(): Promise<void> {
  const vitestEntry = fileURLToPath(
    new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)
  );
  const config = fileURLToPath(
    new URL("../../vitest.kernel-integration.config.ts", import.meta.url)
  );
  const redisTest = fileURLToPath(
    new URL("../__tests__/kernel-redis-integration.test.ts", import.meta.url)
  );
  const postgresTest = fileURLToPath(
    new URL("../__tests__/kernel-postgres-integration.test.ts", import.meta.url)
  );
  await runCommand(
    process.execPath,
    [vitestEntry, "run", redisTest, postgresTest, "--config", config],
    process.env,
    "inherit"
  );
}

async function restartOwnedRedis(): Promise<void> {
  const dockerCommand = requiredWorkerEnvironment("KERNEL_DOCKER_COMMAND");
  const composeFile = requiredWorkerEnvironment("KERNEL_COMPOSE_FILE");
  const projectName = requiredWorkerEnvironment("KERNEL_COMPOSE_PROJECT");
  await runCommand(dockerCommand, [
    "compose",
    "-f",
    composeFile,
    "-p",
    projectName,
    "restart",
    "redis"
  ]);
  await runCommand(dockerCommand, [
    "compose",
    "-f",
    composeFile,
    "-p",
    projectName,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "60"
  ]);
}

async function readDependencyVersions(
  redisEnvironment: KernelRedisEnvironment,
  postgresEnvironment: KernelPostgresEnvironment
): Promise<{ redis: string; postgres: string; pgvector: string }> {
  const redisInfo = await redisEnvironment.clients[0].info("server");
  const redisVersion = /(?:^|\n)redis_version:([^\r\n]+)/.exec(redisInfo)?.[1];
  const postgres = await postgresEnvironment.pools[0].query<{ server_version: string }>(
    "show server_version"
  );
  const pgvector = await postgresEnvironment.pools[0].query<{ extversion: string }>(
    "select extversion from pg_extension where extname='vector'"
  );
  return {
    redis: normalizeVersion(redisVersion),
    postgres: normalizeVersion(postgres.rows[0]?.server_version),
    pgvector: normalizeVersion(pgvector.rows[0]?.extversion)
  };
}

function normalizeVersion(value: string | undefined): string {
  const match = /^v?(\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.]+)?)/i.exec(value?.trim() ?? "");
  if (!match?.[1]) throw new Error("kernel_integration_dependency_version_invalid");
  return match[1];
}

function requiredWorkerEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("kernel_integration_worker_environment_missing");
  return value;
}

function sendWorkerMessage(message: WorkerMessage): void {
  process.send?.(message);
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "success" || type === "failure";
}

async function runCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  stdio: "ignore" | "inherit" = "ignore"
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio, windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("kernel_integration_command_failed"));
    });
  });
}

async function reserveLoopbackPorts(
  count: number
): Promise<Array<{ port: number; release(): Promise<void> }>> {
  const servers: Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("kernel_integration_port_reservation_failed");
      }
      let released = false;
      return {
        port: address.port,
        async release() {
          if (released) return;
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
          released = true;
        }
      };
    });
  } catch (error) {
    await Promise.allSettled(
      servers.map(
        async (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    throw error;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  if (process.argv.includes("--worker")) {
    await runMatrixWorkerMain();
  } else {
    process.exitCode = await runKernelIntegrationCli();
  }
}
