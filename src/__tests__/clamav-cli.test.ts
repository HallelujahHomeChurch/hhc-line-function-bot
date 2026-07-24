import { describe, expect, it, vi } from "vitest";

import { scanWithClamAvCli, type ClamAvExecFile } from "../attachments/clamav-cli.js";

function execResult(error: Parameters<Parameters<ClamAvExecFile>[3]>[0]): ClamAvExecFile {
  return vi.fn((_command, _args, _options, callback) => {
    callback(error, "private scanner output", "private scanner error");
    return undefined;
  });
}

describe("ClamAV CLI scanner", () => {
  it("maps exit 0 to clean and passes the bounded database and file arguments", async () => {
    const execFile = execResult(null);

    const result = await scanWithClamAvCli({
      filePath: "/tmp/work/file",
      databaseDirectory: "/var/lib/clamav/current",
      timeoutMs: 15_000,
      execFile
    });

    expect(result).toEqual({ status: "clean" });
    expect(execFile).toHaveBeenCalledWith(
      "clamscan",
      ["--no-summary", "--stdout", "--database=/var/lib/clamav/current", "--", "/tmp/work/file"],
      expect.objectContaining({ timeout: 15_000, windowsHide: true }),
      expect.any(Function)
    );
  });

  it("maps exit 1 to infected without returning scanner output", async () => {
    const result = await scanWithClamAvCli({
      filePath: "/tmp/work/file",
      databaseDirectory: "/var/lib/clamav/current",
      timeoutMs: 15_000,
      execFile: execResult(Object.assign(new Error("private signature name"), { code: 1 }))
    });

    expect(result).toEqual({ status: "infected" });
  });

  it("maps a timeout to unavailable without returning scanner output", async () => {
    const result = await scanWithClamAvCli({
      filePath: "/tmp/work/file",
      databaseDirectory: "/var/lib/clamav/current",
      timeoutMs: 15_000,
      execFile: execResult(
        Object.assign(new Error("private timeout details"), {
          code: null,
          killed: true,
          signal: "SIGTERM"
        })
      )
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("maps scanner startup and unexpected exits to unavailable", async () => {
    const result = await scanWithClamAvCli({
      filePath: "/tmp/work/file",
      databaseDirectory: "/var/lib/clamav/current",
      timeoutMs: 15_000,
      execFile: execResult(Object.assign(new Error("ENOENT private path"), { code: "ENOENT" }))
    });

    expect(result).toEqual({ status: "unavailable" });
  });
});
