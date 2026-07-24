import { execFile as nodeExecFile } from "node:child_process";

type ExecFileError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

export type ClamAvExecFile = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
  },
  callback: (error: ExecFileError | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => unknown;

export interface ClamAvCliScanResult {
  status: "clean" | "infected" | "unavailable";
}

export async function scanWithClamAvCli(input: {
  filePath: string;
  databaseDirectory: string;
  timeoutMs: number;
  execFile?: ClamAvExecFile;
}): Promise<ClamAvCliScanResult> {
  const execFile = input.execFile ?? (nodeExecFile as ClamAvExecFile);
  return new Promise((resolve) => {
    try {
      execFile(
        "clamscan",
        ["--no-summary", "--stdout", `--database=${input.databaseDirectory}`, "--", input.filePath],
        {
          timeout: input.timeoutMs,
          windowsHide: true,
          maxBuffer: 64 * 1024
        },
        (error) => {
          if (!error) {
            resolve({ status: "clean" });
            return;
          }
          if (error.code === 1) {
            resolve({ status: "infected" });
            return;
          }
          resolve({ status: "unavailable" });
        }
      );
    } catch {
      resolve({ status: "unavailable" });
    }
  });
}
