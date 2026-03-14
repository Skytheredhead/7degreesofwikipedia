import path from "node:path";

const rootDir = process.cwd();

export const appConfig = {
  rootDir,
  dataDir: path.join(rootDir, "data"),
  artifactDir: path.join(rootDir, "artifacts"),
  artifactRootDir: path.join(rootDir, "artifacts", "wiki-runtime"),
  artifactPath: path.join(rootDir, "artifacts", "wiki-runtime", "manifest.json"),
  artifactMetaPath: path.join(rootDir, "artifacts", "wiki-runtime", "summary.json"),
  statsDir: path.join(rootDir, "artifacts", "stats"),
  statsLifetimePath: path.join(rootDir, "artifacts", "stats", "lifetime.json"),
  statsRecentPath: path.join(rootDir, "artifacts", "stats", "recent.json"),
  statsLogPath: path.join(rootDir, "artifacts", "stats", "searches.ndjson"),
  defaultPort: Number(process.env.PORT ?? 7878),
  defaultHost: process.env.HOST ?? "127.0.0.1",
  autocompleteDefaultLimit: 12,
  autocompleteMaxLimit: 50,
  recentSearchLimit: 100,
  cacheSize: Number(process.env.PATH_CACHE_SIZE ?? 5000),
  maxDisplayedRoutes: Number(process.env.MAX_DISPLAYED_ROUTES ?? 100),
  buildVersion: 1
};
