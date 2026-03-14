import fs from "node:fs";
import path from "node:path";

import { appConfig } from "../config.js";
import type { DumpFileInfo, DumpPaths } from "../shared/types.js";

function findSingleFile(patterns: RegExp[]): string | null {
  if (!fs.existsSync(appConfig.dataDir)) {
    return null;
  }

  const entries = fs.readdirSync(appConfig.dataDir);
  for (const entry of entries) {
    if (patterns.some((pattern) => pattern.test(entry))) {
      return path.join(appConfig.dataDir, entry);
    }
  }

  return null;
}

export function discoverDumpPaths(): {
  dumps: Partial<DumpPaths>;
  missing: (keyof DumpPaths)[];
} {
  const page = findSingleFile([/^enwiki-.*-page\.sql\.gz$/]);
  const redirect = findSingleFile([/^enwiki-.*-redirect\.sql\.gz$/]);
  const linktarget = findSingleFile([/^enwiki-.*-linktarget\.sql\.gz$/]);
  const pagelinks = findSingleFile([/^enwiki-.*-pagelinks\.sql\.gz$/]);

  const dumps: Partial<DumpPaths> = {};
  if (page) {
    dumps.page = page;
  }
  if (redirect) {
    dumps.redirect = redirect;
  }
  if (linktarget) {
    dumps.linktarget = linktarget;
  }
  if (pagelinks) {
    dumps.pagelinks = pagelinks;
  }

  const missing = (["page", "redirect", "linktarget", "pagelinks"] as Array<keyof DumpPaths>).filter(
    (key) => !dumps[key]
  );

  return { dumps, missing };
}

export function requireDumpPaths(): DumpPaths {
  const { dumps, missing } = discoverDumpPaths();
  if (missing.length > 0) {
    throw new Error(
      `Missing required dump file(s): ${missing.join(", ")} in ${appConfig.dataDir}. ` +
        "Expected files matching enwiki-*-page.sql.gz, enwiki-*-redirect.sql.gz, enwiki-*-linktarget.sql.gz, enwiki-*-pagelinks.sql.gz."
    );
  }

  return dumps as DumpPaths;
}

export function statDumpFiles(dumps: DumpPaths): Record<string, DumpFileInfo> {
  return Object.fromEntries(
    Object.entries(dumps).map(([key, filePath]) => {
      const stat = fs.statSync(filePath);
      return [
        key,
        {
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        } satisfies DumpFileInfo
      ];
    })
  );
}
