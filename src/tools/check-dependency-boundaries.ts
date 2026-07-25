import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { checkDependencyBoundaries, type SourceFile } from "../architecture/dependency-rules.js";

async function sourceFiles(root: string): Promise<SourceFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<SourceFile[]> => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(entryPath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return [];
      }
      return [
        {
          path: entryPath.replaceAll("\\", "/"),
          source: await readFile(entryPath, "utf8")
        }
      ];
    })
  );
  return files.flat();
}

const files = (await sourceFiles("src")).map((file) => ({
  ...file,
  path: file.path.replace(/^.*?src\//u, "src/")
}));
const violations = checkDependencyBoundaries(files);

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.importer} -> ${violation.imported}: ${violation.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Architecture boundaries pass (${files.length} TypeScript files checked).`);
}
