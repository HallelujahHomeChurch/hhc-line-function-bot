import path from "node:path";

export interface SourceFile {
  path: string;
  source: string;
}

export interface BoundaryViolation {
  importer: string;
  imported: string;
  rule: string;
}

type ModuleLayer = "bootstrap" | "transport" | "application" | "capabilities" | "infrastructure";

const FORBIDDEN_IMPORTS: Record<ModuleLayer, ModuleLayer[]> = {
  bootstrap: [],
  transport: ["bootstrap", "infrastructure"],
  application: ["bootstrap", "transport", "infrastructure"],
  capabilities: ["bootstrap", "transport", "infrastructure"],
  infrastructure: ["bootstrap", "transport"]
};

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;

export function checkDependencyBoundaries(files: SourceFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const file of files) {
    const importer = normalizeSourcePath(file.path);
    const importerLayer = layerFor(importer);

    if (
      /^\s*\/\/\s*architecture:compatibility-facade\s*$/mu.test(file.source) &&
      !containsOnlyReexports(file.source)
    ) {
      violations.push({
        importer,
        imported: importer,
        rule: "compatibility_facade_must_only_reexport"
      });
    }

    if (!importerLayer) {
      continue;
    }

    for (const specifier of importSpecifiers(file.source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const imported = resolveSourceImport(importer, specifier);
      const importedLayer = layerFor(imported);
      if (!importedLayer || !FORBIDDEN_IMPORTS[importerLayer].includes(importedLayer)) {
        continue;
      }
      violations.push({
        importer,
        imported,
        rule: `${importerLayer}_must_not_import_${importedLayer}`
      });
    }
  }

  return violations.sort((left, right) =>
    [left.importer, left.imported, left.rule]
      .join("\0")
      .localeCompare([right.importer, right.imported, right.rule].join("\0"))
  );
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2]);
}

function resolveSourceImport(importer: string, specifier: string): string {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  return normalizeSourcePath(resolved);
}

function normalizeSourcePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized.replace(/\.(?:js|mjs|cjs)$/u, ".ts");
}

function layerFor(filePath: string): ModuleLayer | undefined {
  const match = /^src\/(bootstrap|transport|application|capabilities|infrastructure)\//u.exec(
    filePath
  );
  return match?.[1] as ModuleLayer | undefined;
}

function containsOnlyReexports(source: string): boolean {
  const withoutMarker = source.replace(/^\s*\/\/\s*architecture:compatibility-facade\s*$/gmu, "");
  const withoutComments = withoutMarker
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
  const withoutReexports = withoutComments.replace(
    /export\s+(?:type\s+)?(?:\{[\s\S]*?\}|\*)\s+from\s+["'][^"']+["']\s*;?/gu,
    ""
  );
  return withoutReexports.trim().length === 0;
}
