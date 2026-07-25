import { describe, expect, it } from "vitest";

import { checkDependencyBoundaries, type SourceFile } from "../architecture/dependency-rules.js";

function check(files: SourceFile[]) {
  return checkDependencyBoundaries(files);
}

describe("modular dependency rules", () => {
  it.each([
    {
      importer: "src/capabilities/example/handler.ts",
      imported: "src/infrastructure/postgres/store.ts",
      rule: "capabilities_must_not_import_infrastructure"
    },
    {
      importer: "src/application/turn/coordinator.ts",
      imported: "src/transport/line/contracts.ts",
      rule: "application_must_not_import_transport"
    },
    {
      importer: "src/transport/line/webhook-routes.ts",
      imported: "src/bootstrap/create-production-runtime.ts",
      rule: "transport_must_not_import_bootstrap"
    },
    {
      importer: "src/infrastructure/postgres/store.ts",
      imported: "src/transport/line/contracts.ts",
      rule: "infrastructure_must_not_import_transport"
    },
    {
      importer: "src/transport/line/webhook-routes.ts",
      imported: "src/clients/line.ts",
      rule: "transport_must_not_import_infrastructure"
    },
    {
      importer: "src/bootstrap/create-production-runtime.ts",
      imported: "src/testing/create-test-runtime.ts",
      rule: "bootstrap_must_not_import_testing"
    }
  ])("rejects $rule", ({ importer, imported, rule }) => {
    expect(
      check([
        {
          path: importer,
          source: `import "${path.posix.relative(path.posix.dirname(importer), imported)}";`
        }
      ])
    ).toEqual([{ importer, imported, rule }]);
  });

  it("accepts the intended inward dependency direction", () => {
    expect(
      check([
        {
          path: "src/bootstrap/create-production-runtime.ts",
          source: [
            'import "../infrastructure/postgres/store.js";',
            'import "../transport/line/webhook-routes.js";',
            'import "../application/turn/coordinator.js";'
          ].join("\n")
        },
        {
          path: "src/transport/line/webhook-routes.ts",
          source: 'import "../../application/turn/contracts.js";'
        },
        {
          path: "src/application/turn/coordinator.ts",
          source: 'import "../../capabilities/query-schedule/ports.js";'
        },
        {
          path: "src/capabilities/query-schedule/handler.ts",
          source: 'import "../../application/contracts/function-execution.js";'
        }
      ])
    ).toEqual([]);
  });

  it("allows type-only references to legacy infrastructure ports during migration", () => {
    expect(
      check([
        {
          path: "src/application/turn/runtime.ts",
          source: 'import type { SessionStore } from "../../state/session-store.js";'
        }
      ])
    ).toEqual([]);
  });

  it("checks imports, re-exports, and dynamic imports while ignoring packages", () => {
    expect(
      check([
        {
          path: "src/application/example.ts",
          source: [
            'import type { FastifyInstance } from "fastify";',
            'export { build } from "../bootstrap/build.js";',
            'const adapter = import("../infrastructure/adapter.js");'
          ].join("\n")
        }
      ])
    ).toEqual([
      {
        importer: "src/application/example.ts",
        imported: "src/bootstrap/build.ts",
        rule: "application_must_not_import_bootstrap"
      },
      {
        importer: "src/application/example.ts",
        imported: "src/infrastructure/adapter.ts",
        rule: "application_must_not_import_infrastructure"
      }
    ]);
  });

  it("requires compatibility facades to contain re-exports only", () => {
    expect(
      check([
        {
          path: "src/server.ts",
          source: [
            "// architecture:compatibility-facade",
            'export { createApp } from "./transport/line/webhook-routes.js";',
            "export const hiddenBusinessRule = true;"
          ].join("\n")
        }
      ])
    ).toEqual([
      {
        importer: "src/server.ts",
        imported: "src/server.ts",
        rule: "compatibility_facade_must_only_reexport"
      }
    ]);
  });
});
import path from "node:path";
