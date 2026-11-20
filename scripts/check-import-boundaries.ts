import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Expression, Node } from "typescript";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from "typescript";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".next",
  ".turbo",
  "dist",
  "node_modules",
]);
const SDK_PACKAGE = "@opencode-ai/sdk";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await sourceFiles(join(directory, entry.name))));
      }
      continue;
    }
    if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function packageSpecifier(node: Node): Expression | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
    return node.argument.literal;
  }
  if (isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return isExternalModuleReference(reference)
      ? reference.expression
      : undefined;
  }
  if (isCallExpression(node) && node.arguments.length > 0) {
    const [argument] = node.arguments;
    const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword;
    const isRequire =
      isIdentifier(node.expression) && node.expression.text === "require";
    const isRequireResolve =
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "resolve" &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "require";
    return isDynamicImport || isRequire || isRequireResolve
      ? argument
      : undefined;
  }
  return undefined;
}

export function findSdkImports(source: string, fileName: string): number[] {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  let scriptKind = ScriptKind.TS;
  if (extension === ".tsx") {
    scriptKind = ScriptKind.TSX;
  } else if (extension === ".jsx") {
    scriptKind = ScriptKind.JSX;
  } else if (extension === ".js") {
    scriptKind = ScriptKind.JS;
  }
  const sourceFile = createSourceFile(
    fileName,
    source,
    ScriptTarget.Latest,
    true,
    scriptKind
  );
  const lines: number[] = [];

  function visit(node: Node): void {
    const specifier = packageSpecifier(node);
    if (
      specifier &&
      isStringLiteralLike(specifier) &&
      (specifier.text === SDK_PACKAGE ||
        specifier.text.startsWith(`${SDK_PACKAGE}/`))
    ) {
      lines.push(
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1
      );
    }
    forEachChild(node, visit);
  }

  visit(sourceFile);
  return lines;
}

async function main(): Promise<void> {
  const files = await Promise.all(
    ["apps", "packages"].map((directory) => sourceFiles(directory))
  );
  const violations: string[] = [];

  for (const file of files.flat()) {
    const relativePath = relative(process.cwd(), file);
    if (relativePath.startsWith("packages/opencode-adapter/")) {
      continue;
    }

    const source = await readFile(file, "utf8");
    for (const line of findSdkImports(source, file)) {
      violations.push(`${relativePath}:${line}`);
    }
  }

  if (violations.length > 0) {
    console.error(
      [
        "OpenCode SDK imports must stay inside packages/opencode-adapter:",
        ...violations,
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  console.log("import-boundaries: ok");
}

if (import.meta.main) {
  await main();
}
