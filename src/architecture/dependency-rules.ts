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

type ModuleLayer =
  "bootstrap" | "transport" | "application" | "capabilities" | "infrastructure" | "testing";

const FORBIDDEN_IMPORTS: Record<ModuleLayer, ModuleLayer[]> = {
  bootstrap: ["testing"],
  transport: ["bootstrap", "infrastructure", "testing"],
  application: ["bootstrap", "transport", "infrastructure", "testing"],
  capabilities: ["bootstrap", "transport", "infrastructure", "testing"],
  infrastructure: ["bootstrap", "transport", "testing"],
  testing: []
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

    for (const { specifier, typeOnly } of importSpecifiers(file.source)) {
      if (effectiveCapabilityProjectionPackageImportIsForbidden(importer, specifier)) {
        violations.push({
          importer,
          imported: specifier,
          rule: "effective_capability_projection_must_not_import_runtime_adapters"
        });
        continue;
      }
      if (effectiveAccessPackageImportIsForbidden(importer, specifier)) {
        violations.push({
          importer,
          imported: specifier,
          rule: "effective_access_must_not_import_runtime_adapters"
        });
        continue;
      }
      if (!specifier.startsWith(".")) {
        continue;
      }
      const imported = resolveSourceImport(importer, specifier);
      if (effectiveCapabilityProjectionImportIsForbidden(importer, imported)) {
        violations.push({
          importer,
          imported,
          rule: "effective_capability_projection_must_not_import_runtime_adapters"
        });
        continue;
      }
      if (effectiveAccessImportIsForbidden(importer, imported)) {
        violations.push({
          importer,
          imported,
          rule: "effective_access_must_not_import_runtime_adapters"
        });
        continue;
      }
      const importedLayer = layerFor(imported);
      if (typeOnly && importedLayer === "infrastructure") {
        continue;
      }
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

function effectiveCapabilityProjectionImportIsForbidden(
  importer: string,
  imported: string
): boolean {
  return Boolean(
    /^src\/application\/capabilities\//u.test(importer) &&
    (/^src\/transport\//u.test(imported) ||
      /^src\/(?:__tests__|testing)\//u.test(imported) ||
      /^src\/(?:access\/postgres-access-store|db\/postgres|redis|clients\/line)/u.test(imported))
  );
}

function effectiveCapabilityProjectionPackageImportIsForbidden(
  importer: string,
  specifier: string
): boolean {
  return Boolean(
    /^src\/application\/capabilities\//u.test(importer) &&
    ["@line/bot-sdk", "pg", "redis"].includes(specifier)
  );
}

function effectiveAccessImportIsForbidden(importer: string, imported: string): boolean {
  return Boolean(
    /^src\/application\/access\//u.test(importer) &&
    (/^src\/transport\//u.test(imported) ||
      /^src\/(?:__tests__|testing)\//u.test(imported) ||
      /^src\/(?:access\/postgres-access-store|db\/postgres|redis|clients\/line)/u.test(imported))
  );
}

function effectiveAccessPackageImportIsForbidden(importer: string, specifier: string): boolean {
  return Boolean(
    /^src\/application\/access\//u.test(importer) &&
    ["@line/bot-sdk", "pg", "redis"].includes(specifier)
  );
}

function importSpecifiers(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => ({
    specifier: match[1] ?? match[2],
    typeOnly: /^\s*(?:import|export)\s+type\b/u.test(match[0])
  }));
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
  if (/^src\/(?:__tests__|testing)\//u.test(filePath)) {
    return "testing";
  }
  if (
    /^src\/(?:clients|db|state|cache|access|idempotency)\//u.test(filePath) ||
    /^src\/(?:redis|rate-limit)\.ts$/u.test(filePath)
  ) {
    return "infrastructure";
  }
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
