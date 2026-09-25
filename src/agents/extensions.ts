import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const NPM_SOURCE_PATTERN =
  /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/[A-Za-z0-9~][A-Za-z0-9._~-]*|[A-Za-z0-9~][A-Za-z0-9._~-]*)$/;
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const EXTENSION_FILE_TYPES = new Set([".js", ".ts"]);

/** Validate and normalize one user-facing extension source. */
export function normalizeExtensionSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const source = value.trim();
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length);
    return NPM_SOURCE_PATTERN.test(spec) ? source : undefined;
  }
  if (!source.startsWith("path:")) return undefined;
  const path = source.slice("path:".length);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    WINDOWS_ABSOLUTE_PATTERN.test(path) ||
    path
      .split(/[\\/]/)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

function lstatExisting(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid extension path.", { cause: error });
  }
}

function canonicalTarget(path: string, boundary: string): string {
  try {
    const target = realpathSync(path);
    if (!isContained(boundary, target))
      throw new Error("Invalid extension path.");
    return target;
  } catch {
    throw new Error("Invalid extension path.");
  }
}

function validateManifestPattern(root: string, entry: string): void {
  if (entry.length === 0 || entry.trim() !== entry) {
    throw new Error("Invalid extension manifest.");
  }
  const pattern = /^[!+-]/.test(entry) ? entry.slice(1) : entry;
  const normalized = pattern.replaceAll("\\", "/");
  const withoutLeadingDot = normalized.startsWith("./")
    ? normalized.slice(2)
    : normalized;
  if (
    withoutLeadingDot.length === 0 ||
    isAbsolute(pattern) ||
    WINDOWS_ABSOLUTE_PATTERN.test(pattern) ||
    withoutLeadingDot
      .split("/")
      .some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
    !isContained(root, resolve(root, withoutLeadingDot))
  ) {
    throw new Error("Invalid extension manifest.");
  }
}

function validateSelectedManifest(directory: string): void {
  const packageJsonPath = join(directory, "package.json");
  if (lstatExisting(packageJsonPath) === undefined) return;
  const canonicalPackageJson = canonicalTarget(packageJsonPath, directory);
  let parsed: unknown;
  try {
    if (!statSync(canonicalPackageJson).isFile())
      throw new Error("Invalid extension manifest.");
    parsed = JSON.parse(readFileSync(canonicalPackageJson, "utf-8"));
  } catch {
    throw new Error("Invalid extension manifest.");
  }
  if (!isRecord(parsed)) throw new Error("Invalid extension manifest.");
  if (!Object.hasOwn(parsed, "pi")) return;
  if (!isRecord(parsed.pi) || !Object.hasOwn(parsed.pi, "extensions")) {
    throw new Error("Invalid extension manifest.");
  }
  const entries = parsed.pi.extensions;
  if (
    !Array.isArray(entries) ||
    !entries.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error("Invalid extension manifest.");
  }
  for (const entry of entries) {
    validateManifestPattern(directory, entry);
    if (!/^[!+-]/.test(entry) && !entry.includes("*") && !entry.includes("?")) {
      const target = resolve(directory, entry.replaceAll("\\", "/"));
      if (lstatExisting(target) === undefined)
        throw new Error("Invalid extension path.");
      canonicalTarget(target, directory);
    }
  }
}

function validatedEntrypoint(path: string, packageRoot: string): string {
  const lexical = resolve(path);
  if (
    !isContained(packageRoot, lexical) ||
    lstatExisting(lexical) === undefined
  ) {
    throw new Error("Invalid extension path.");
  }
  const canonical = canonicalTarget(lexical, packageRoot);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(canonical);
  } catch {
    throw new Error("Invalid extension path.");
  }
  if (stats.isFile()) {
    if (!EXTENSION_FILE_TYPES.has(extname(canonical))) {
      throw new Error("Unsupported extension target.");
    }
    return canonical;
  }
  if (!stats.isDirectory()) throw new Error("Unsupported extension target.");

  validateSelectedManifest(canonical);
  for (const name of ["index.ts", "index.js"]) {
    const entry = join(canonical, name);
    if (lstatExisting(entry) !== undefined)
      return validatedEntrypoint(entry, packageRoot);
  }
  throw new Error("Unsupported extension target.");
}

async function resolveLocalPackage(
  packageRoot: string,
  cwd: string,
  agentDir: string,
): Promise<string[]> {
  const stats = statSync(packageRoot);
  if (stats.isFile()) return [validatedEntrypoint(packageRoot, packageRoot)];
  if (!stats.isDirectory()) throw new Error("Unsupported extension target.");

  validateSelectedManifest(packageRoot);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const resources = await packageManager.resolveExtensionSources([packageRoot]);
  const resolved = resources.extensions
    .filter((resource) => resource.enabled)
    .map((resource) => validatedEntrypoint(resource.path, packageRoot));
  if (resolved.length === 0) throw new Error("Unsupported extension target.");
  return [...new Set(resolved)];
}

async function existingCandidate(
  root: string,
  relativePath: string,
  cwd: string,
  agentDir: string,
): Promise<string[] | undefined> {
  const lexicalRoot = resolve(root);
  const candidate = resolve(lexicalRoot, relativePath);
  if (!isContained(lexicalRoot, candidate))
    throw new Error("Invalid extension path.");
  if (lstatExisting(candidate) === undefined) return undefined;

  let physicalRoot: string;
  let physicalTarget: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
    physicalTarget = realpathSync(candidate);
  } catch {
    throw new Error("Invalid extension path.");
  }
  if (!isContained(physicalRoot, physicalTarget))
    throw new Error("Invalid extension path.");
  return resolveLocalPackage(physicalTarget, cwd, agentDir);
}

/** Resolve normalized sources to already-installed, validated extension entrypoints. */
export async function resolveExtensionSources(
  sources: readonly string[],
  cwd: string,
  agentDir: string,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const source of sources) {
    const npmSource = source.startsWith("npm:");
    const relativePath = npmSource
      ? source.slice("npm:".length)
      : source.slice("path:".length);
    if (npmSource && !NPM_SOURCE_PATTERN.test(relativePath)) {
      throw new Error("Invalid extension source.");
    }
    const roots = npmSource
      ? [
          join(cwd, ".pi", "npm", "node_modules"),
          join(agentDir, "npm", "node_modules"),
        ]
      : [join(cwd, ".pi"), agentDir];
    let found: string[] | undefined;
    for (const root of roots) {
      found = await existingCandidate(root, relativePath, cwd, agentDir);
      if (found !== undefined) break;
    }
    if (found === undefined) {
      throw new Error(
        npmSource
          ? "Extension package is not installed."
          : "Extension path does not exist.",
      );
    }
    resolved.push(...found);
  }
  return [...new Set(resolved)];
}
