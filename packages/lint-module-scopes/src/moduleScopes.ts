import * as fs from "node:fs";
import * as path from "node:path";

import { definePlugin, defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { ResolverFactory } from "oxc-resolver";

const SCOPE_ENTRYPOINTS = ["index.ts", "index.js"] as const;

const importResolver = new ResolverFactory({
  conditionNames: ["node", "import", "default"],

  extensions: [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
  ],

  /*
   * Support TypeScript projects that write runtime-compatible imports:
   *
   *   import { value } from "./module.js";
   *
   * where the source file is actually module.ts.
   */
  extensionAlias: {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"],
  },

  mainFields: ["module", "main"],
  mainFiles: ["index"],
});

const requireResolver = importResolver.cloneWithOptions({
  conditionNames: ["node", "require", "default"],
});

type ResolutionMode = "import" | "require";

interface Scope {
  readonly directory: string;
  readonly entrypoints: readonly string[];
}

interface StaticSpecifier {
  readonly node: ESTree.Node;
  readonly value: string;
}

function normalizeForComparison(filePath: string): string {
  const normalized = path.normalize(filePath);

  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function samePath(left: string, right: string): boolean {
  return (
    normalizeForComparison(left) ===
    normalizeForComparison(right)
  );
}

function canonicalize(filePath: string): string {
  const absolutePath = path.resolve(filePath);

  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isInside(
  parentDirectory: string,
  candidate: string,
): boolean {
  const relative = path.relative(parentDirectory, candidate);

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function usesUnsupportedProtocol(specifier: string): boolean {
  /*
   * Ignores node:, data:, http:, file:, and other URL-like imports.
   * TypeScript package imports beginning with "#" are not excluded.
   */
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

function stripQueryAndFragment(specifier: string): string {
  const queryIndex = specifier.indexOf("?");

  /*
   * Preserve package-import specifiers such as "#internal".
   */
  const fragmentIndex = specifier.indexOf("#", 1);

  const indexes = [queryIndex, fragmentIndex].filter(
    (index) => index >= 0,
  );

  if (indexes.length === 0) {
    return specifier;
  }

  return specifier.slice(0, Math.min(...indexes));
}

function isNodeModulesPath(filePath: string): boolean {
  return path
    .normalize(filePath)
    .split(path.sep)
    .includes("node_modules");
}

function readStaticSpecifier(
  candidate: unknown,
): StaticSpecifier | null {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("type" in candidate)
  ) {
    return null;
  }

  const node = candidate as ESTree.Node;

  if (
    "value" in candidate &&
    typeof candidate.value === "string"
  ) {
    return {
      node,
      value: candidate.value,
    };
  }

  /*
   * Also support:
   *
   *   import(`./module`)
   *   require(`./module`)
   *
   * when the template contains no expressions.
   */
  if (
    candidate.type === "TemplateLiteral" &&
    "expressions" in candidate &&
    Array.isArray(candidate.expressions) &&
    candidate.expressions.length === 0 &&
    "quasis" in candidate &&
    Array.isArray(candidate.quasis) &&
    candidate.quasis.length === 1
  ) {
    const quasi = candidate.quasis[0];

    if (
      typeof quasi === "object" &&
      quasi !== null &&
      "value" in quasi &&
      typeof quasi.value === "object" &&
      quasi.value !== null
    ) {
      const value = quasi.value as {
        cooked?: unknown;
        raw?: unknown;
      };

      const text =
        typeof value.cooked === "string"
          ? value.cooked
          : typeof value.raw === "string"
            ? value.raw
            : null;

      if (text !== null) {
        return {
          node,
          value: text,
        };
      }
    }
  }

  return null;
}

function resolveImport(
  importerFile: string,
  specifier: string,
  mode: ResolutionMode,
): string | null {
  if (usesUnsupportedProtocol(specifier)) {
    return null;
  }

  const resolvableSpecifier =
    stripQueryAndFragment(specifier);

  if (resolvableSpecifier.length === 0) {
    return null;
  }

  const resolver =
    mode === "require"
      ? requireResolver
      : importResolver;

  try {
    const resolution = resolver.resolveFileSync(
      importerFile,
      resolvableSpecifier,
    );

    if (
      !resolution ||
      typeof resolution.path !== "string"
    ) {
      return null;
    }

    return canonicalize(resolution.path);
  } catch {
    /*
     * Resolution failures belong to TypeScript or an unresolved-import
     * rule. This rule only evaluates successfully resolved modules.
     */
    return null;
  }
}

function findNearestScope(
  filePath: string,
  cache: Map<string, Scope | null>,
): Scope | null {
  let directory = path.dirname(filePath);
  const visitedDirectories: string[] = [];

  let result: Scope | null = null;

  while (true) {
    const cacheKey =
      normalizeForComparison(directory);

    if (cache.has(cacheKey)) {
      result = cache.get(cacheKey) ?? null;
      break;
    }

    visitedDirectories.push(cacheKey);

    const entrypoints = SCOPE_ENTRYPOINTS
      .map((filename) => path.join(directory, filename))
      .filter(isFile)
      .map(canonicalize);

    if (entrypoints.length > 0) {
      result = {
        directory,
        entrypoints,
      };

      break;
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      result = null;
      break;
    }

    directory = parent;
  }

  for (const cacheKey of visitedDirectories) {
    cache.set(cacheKey, result);
  }

  return result;
}

function isScopeEntrypoint(
  filePath: string,
  scope: Scope,
): boolean {
  return scope.entrypoints.some((entrypoint) =>
    samePath(filePath, entrypoint),
  );
}

function toModuleSpecifier(
  importerFile: string,
  targetDirectory: string,
): string {
  let specifier = path
    .relative(
      path.dirname(importerFile),
      targetDirectory,
    )
    .split(path.sep)
    .join("/");

  if (specifier === "") {
    return ".";
  }

  if (!specifier.startsWith(".")) {
    specifier = `./${specifier}`;
  }

  return specifier;
}

function displayPath(
  cwd: string,
  target: string,
): string {
  const absoluteCwd = canonicalize(cwd);

  if (isInside(absoluteCwd, target)) {
    const relative = path.relative(absoluteCwd, target);

    return relative === ""
      ? "."
      : relative.split(path.sep).join("/");
  }

  return target.split(path.sep).join("/");
}

const noCrossScopeImport = defineRule({
  meta: {
    type: "problem",

    docs: {
      description:
        "Disallow direct imports across directory scopes defined by index.ts or index.js",
    },

    /*
     * This rule intentionally accepts no configuration.
     */
    schema: [],

    messages: {
      crossScope:
        'Import "{{specifier}}" crosses into scope "{{scope}}". Import through "{{entrypoint}}" instead.',
    },
  },

  create(context) {
    const reportedFilename =
      context.physicalFilename || context.filename;

    if (
      !reportedFilename ||
      reportedFilename === "<text>" ||
      reportedFilename.startsWith("<")
    ) {
      return {};
    }

    const importerFile = canonicalize(
      path.isAbsolute(reportedFilename)
        ? reportedFilename
        : path.resolve(context.cwd, reportedFilename),
    );

    /*
     * Keep this cache local to the linted file. That avoids stale scope
     * information when an editor creates or removes an index file.
     */
    const scopeCache = new Map<
      string,
      Scope | null
    >();

    const importerScope = findNearestScope(
      importerFile,
      scopeCache,
    );

    function checkSpecifier(
      candidate: unknown,
      mode: ResolutionMode,
    ): void {
      const source = readStaticSpecifier(candidate);

      if (!source) {
        return;
      }

      const targetFile = resolveImport(
        importerFile,
        source.value,
        mode,
      );

      if (
        !targetFile ||
        isNodeModulesPath(targetFile)
      ) {
        return;
      }

      const targetScope = findNearestScope(
        targetFile,
        scopeCache,
      );

      /*
       * No indexed ancestor means the target does not belong to a
       * visibility scope.
       */
      if (!targetScope) {
        return;
      }

      /*
       * Direct imports are allowed within the same nearest scope.
       */
      if (
        importerScope &&
        samePath(
          importerScope.directory,
          targetScope.directory,
        )
      ) {
        return;
      }

      /*
       * Importing either index.ts or index.js directly is valid.
       * Both "../scope" and "../scope/index.js" therefore count as
       * entrypoint imports.
       */
      if (isScopeEntrypoint(targetFile, targetScope)) {
        return;
      }

      context.report({
        node: source.node,
        messageId: "crossScope",
        data: {
          specifier: source.value,
          scope: displayPath(
            context.cwd,
            targetScope.directory,
          ),
          entrypoint: toModuleSpecifier(
            importerFile,
            targetScope.directory,
          ),
        },
      });
    }

    return {
      ImportDeclaration(node) {
        checkSpecifier(node.source, "import");
      },

      ExportNamedDeclaration(node) {
        checkSpecifier(node.source, "import");
      },

      ExportAllDeclaration(node) {
        checkSpecifier(node.source, "import");
      },

      ImportExpression(node) {
        checkSpecifier(node.source, "import");
      },

      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "require" ||
          node.arguments.length !== 1
        ) {
          return;
        }

        checkSpecifier(node.arguments[0], "require");
      },

      /*
       * Handles:
       *
       *   type Value = import("./module").Value;
       */
      TSImportType(node: ESTree.Node) {
        const argument = (
          node as ESTree.Node & {
            argument?: unknown;
          }
        ).argument;

        checkSpecifier(argument, "import");
      },

      /*
       * Handles:
       *
       *   import value = require("./module");
       */
      TSExternalModuleReference(node: ESTree.Node) {
        const expression = (
          node as ESTree.Node & {
            expression?: unknown;
          }
        ).expression;

        checkSpecifier(expression, "require");
      },
    };
  },
});

export default definePlugin({
  meta: {
    name: "module-scopes",
  },

  rules: {
    "no-cross-scope-import": noCrossScopeImport,
  },
});