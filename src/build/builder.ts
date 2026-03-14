import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";

import { appConfig } from "../config.js";
import { dbTitleToDisplayTitle, normalizePrefixKey, normalizeTitleForSearch } from "../shared/normalize.js";
import type { DumpPaths, RuntimeArtifact } from "../shared/types.js";
import { discoverDumpPaths, requireDumpPaths, statDumpFiles } from "./discover.js";
import { readTableSchema, scanInsertRows, type SqlTableSchema } from "./sqlReader.js";

interface RedirectAlias {
  title: string;
  searchKey: string;
  targetNodeId: number;
}

type ExactLookupBuckets = Map<string, Map<string, number>>;
type ChunkKind = "string" | "u32" | "u8";

interface ChunkManifest {
  kind: ChunkKind;
  length: number;
  files: string[];
}

interface PersistedArtifactManifest {
  version: number;
  builtAt: string;
  dumpFiles: Record<string, RuntimeArtifact["dumpFiles"][string]>;
  counts: RuntimeArtifact["counts"];
  prefixBuckets: Record<string, [number, number]>;
  chunks: {
    canonicalTitles: ChunkManifest;
    canonicalSearchKeys: ChunkManifest;
    aliasTitles: ChunkManifest;
    aliasSearchKeys: ChunkManifest;
    aliasTargetNodeIds: ChunkManifest;
    aliasKinds: ChunkManifest;
    sortedAliasIndices: ChunkManifest;
    forwardOffsets: ChunkManifest;
    forwardAdjacency: ChunkManifest;
    reverseOffsets: ChunkManifest;
    reverseAdjacency: ChunkManifest;
  };
}

interface PagePassResult {
  canonicalTitles: string[];
  canonicalSearchKeys: string[];
  pageIdToCanonicalNodeId: Uint32Array;
  titleKeyToPageIdBuckets: ExactLookupBuckets;
  redirectSourcePageIds: number[];
  redirectTitles: string[];
  redirectSearchKeys: string[];
  maxPageId: number;
  mainspacePageCount: number;
}

const INVALID_NODE_ID = 0xffffffff;
const INVALID_PAGE_ID = 0xffffffff;
const UNRESOLVED_NODE_ID = -2;
const NO_RESOLVED_NODE_ID = -1;

function indexOfColumn(schema: SqlTableSchema, column: string): number {
  const index = schema.columnIndex.get(column);
  if (index === undefined) {
    throw new Error(`Column ${column} not found in ${schema.tableName} schema`);
  }

  return index;
}

async function parsePageDump(filePath: string): Promise<PagePassResult> {
  const schema = await readTableSchema(filePath, "page");
  const pageIdIndex = indexOfColumn(schema, "page_id");
  const namespaceIndex = indexOfColumn(schema, "page_namespace");
  const titleIndex = indexOfColumn(schema, "page_title");
  const redirectIndex = indexOfColumn(schema, "page_is_redirect");

  const canonicalTitles: string[] = [];
  const canonicalSearchKeys: string[] = [];
  const canonicalPageIds: number[] = [];
  const redirectSourcePageIds: number[] = [];
  const redirectTitles: string[] = [];
  const redirectSearchKeys: string[] = [];
  const titleKeyToPageIdBuckets: ExactLookupBuckets = new Map();
  let maxPageId = 0;
  let mainspacePageCount = 0;

  await scanInsertRows(
    filePath,
    "page",
    (row) => {
      const namespace = row[namespaceIndex];
      if (namespace !== 0) {
        return;
      }

      const pageId = row[pageIdIndex];
      const rawTitle = row[titleIndex];
      const isRedirect = row[redirectIndex];
      if (typeof pageId !== "number" || typeof rawTitle !== "string" || typeof isRedirect !== "number") {
        return;
      }

      const title = dbTitleToDisplayTitle(rawTitle);
      const searchKey = normalizeTitleForSearch(title);
      setBucketedLookup(titleKeyToPageIdBuckets, searchKey, pageId);
      maxPageId = Math.max(maxPageId, pageId);
      mainspacePageCount += 1;

      if (isRedirect === 0) {
        canonicalPageIds.push(pageId);
        canonicalTitles.push(title);
        canonicalSearchKeys.push(searchKey);
      } else {
        redirectSourcePageIds.push(pageId);
        redirectTitles.push(title);
        redirectSearchKeys.push(searchKey);
      }
    },
    {
      progressEveryRows: 2_000_000,
      onProgress: (rows) => {
        logPhase(
          `page parse scanned ${rows.toLocaleString()} rows, kept ${mainspacePageCount.toLocaleString()} ns=0 pages`
        );
      }
    }
  );

  const pageIdToCanonicalNodeId = new Uint32Array(maxPageId + 1);
  pageIdToCanonicalNodeId.fill(INVALID_NODE_ID);
  for (let nodeId = 0; nodeId < canonicalPageIds.length; nodeId += 1) {
    pageIdToCanonicalNodeId[canonicalPageIds[nodeId]!] = nodeId;
  }

  return {
    canonicalTitles,
    canonicalSearchKeys,
    pageIdToCanonicalNodeId,
    titleKeyToPageIdBuckets,
    redirectSourcePageIds,
    redirectTitles,
    redirectSearchKeys,
    maxPageId,
    mainspacePageCount
  };
}

function setBucketedLookup(buckets: ExactLookupBuckets, key: string, value: number): void {
  const prefix = normalizePrefixKey(key);
  let bucket = buckets.get(prefix);
  if (!bucket) {
    bucket = new Map<string, number>();
    buckets.set(prefix, bucket);
  }

  if (!bucket.has(key)) {
    bucket.set(key, value);
  }
}

function getBucketedLookup(buckets: ExactLookupBuckets, key: string): number | undefined {
  return buckets.get(normalizePrefixKey(key))?.get(key);
}

async function parseRedirectDump(
  filePath: string,
  pages: PagePassResult
): Promise<{ redirectTargetPageIdBySource: Uint32Array; redirectCount: number }> {
  const schema = await readTableSchema(filePath, "redirect");
  const sourceIndex = indexOfColumn(schema, "rd_from");
  const namespaceIndex = indexOfColumn(schema, "rd_namespace");
  const titleIndex = indexOfColumn(schema, "rd_title");
  const interwikiIndex = indexOfColumn(schema, "rd_interwiki");

  const redirectTargetPageIdBySource = new Uint32Array(pages.maxPageId + 1);
  redirectTargetPageIdBySource.fill(INVALID_PAGE_ID);
  let redirectCount = 0;

  await scanInsertRows(
    filePath,
    "redirect",
    (row) => {
      const sourcePageId = row[sourceIndex];
      const namespace = row[namespaceIndex];
      const targetTitle = row[titleIndex];
      const interwiki = row[interwikiIndex];
      if (typeof sourcePageId !== "number" || namespace !== 0 || typeof targetTitle !== "string") {
        return;
      }

      if (typeof interwiki === "string" && interwiki.length > 0) {
        return;
      }

      const title = dbTitleToDisplayTitle(targetTitle);
      const targetPageId = getBucketedLookup(pages.titleKeyToPageIdBuckets, normalizeTitleForSearch(title));
      redirectCount += 1;
      if (targetPageId !== undefined && sourcePageId <= pages.maxPageId) {
        redirectTargetPageIdBySource[sourcePageId] = targetPageId;
      }
    },
    {
      progressEveryRows: 2_000_000,
      onProgress: (rows) => {
        logPhase(`redirect parse scanned ${rows.toLocaleString()} rows, kept ${redirectCount.toLocaleString()} redirects`);
      }
    }
  );

  return { redirectTargetPageIdBySource, redirectCount };
}

function resolveRedirectAliases(
  pages: PagePassResult,
  redirectTargetPageIdBySource: Uint32Array
): RedirectAlias[] {
  const resolvedNodeIdByPageId = new Int32Array(pages.maxPageId + 1);
  resolvedNodeIdByPageId.fill(UNRESOLVED_NODE_ID);

  const resolvePageId = (pageId: number): number | null => {
    const chain: number[] = [];
    const active = new Set<number>();
    let current = pageId;

    while (true) {
      const canonical = pages.pageIdToCanonicalNodeId[current];
      if (canonical !== undefined && canonical !== INVALID_NODE_ID) {
        for (const id of chain) {
          resolvedNodeIdByPageId[id] = canonical;
        }
        return canonical;
      }

      const memo = resolvedNodeIdByPageId[current];
      if (memo !== undefined && memo !== UNRESOLVED_NODE_ID) {
        const resolved = memo === NO_RESOLVED_NODE_ID ? null : memo;
        for (const id of chain) {
          resolvedNodeIdByPageId[id] = memo;
        }
        return resolved;
      }

      if (active.has(current)) {
        for (const id of chain) {
          resolvedNodeIdByPageId[id] = NO_RESOLVED_NODE_ID;
        }
        return null;
      }

      const targetPageId = redirectTargetPageIdBySource[current];
      if (targetPageId === undefined || targetPageId === INVALID_PAGE_ID) {
        for (const id of chain) {
          resolvedNodeIdByPageId[id] = NO_RESOLVED_NODE_ID;
        }
        return null;
      }

      active.add(current);
      chain.push(current);
      current = targetPageId;
    }
  };

  const aliases: RedirectAlias[] = [];
  for (let index = 0; index < pages.redirectSourcePageIds.length; index += 1) {
    const pageId = pages.redirectSourcePageIds[index]!;
    const sourceTitle = pages.redirectTitles[index]!;
    const sourceKey = pages.redirectSearchKeys[index]!;
    const targetNodeId = resolvePageId(pageId);
    if (targetNodeId === null) {
      continue;
    }

    aliases.push({
      title: sourceTitle,
      searchKey: sourceKey,
      targetNodeId
    });
  }

  return aliases;
}

function buildAliasIndexes(
  canonicalTitles: string[],
  canonicalSearchKeys: string[],
  redirectAliases: RedirectAlias[]
): RuntimeArtifact["titles"] {
  const aliasTitles = canonicalTitles.slice();
  const aliasSearchKeys = canonicalSearchKeys.slice();
  const aliasKinds = new Uint8Array(canonicalTitles.length + redirectAliases.length);
  const aliasTargetNodeIds = new Uint32Array(canonicalTitles.length + redirectAliases.length);

  for (let nodeId = 0; nodeId < canonicalTitles.length; nodeId += 1) {
    aliasTargetNodeIds[nodeId] = nodeId;
    aliasKinds[nodeId] = 0;
  }

  for (const redirect of redirectAliases) {
    aliasTitles.push(redirect.title);
    aliasSearchKeys.push(redirect.searchKey);
  }

  for (let index = 0; index < redirectAliases.length; index += 1) {
    const aliasIndex = canonicalTitles.length + index;
    aliasTargetNodeIds[aliasIndex] = redirectAliases[index]!.targetNodeId;
    aliasKinds[aliasIndex] = 1;
  }

  const exactAliasBuckets: ExactLookupBuckets = new Map();
  for (let index = 0; index < aliasSearchKeys.length; index += 1) {
    const searchKey = aliasSearchKeys[index]!;
    setBucketedLookup(exactAliasBuckets, searchKey, index);
  }

  const sortedIndicesArray = Array.from({ length: aliasTitles.length }, (_, index) => index);
  sortedIndicesArray.sort((left, right) => {
    const leftKey = aliasSearchKeys[left]!;
    const rightKey = aliasSearchKeys[right]!;
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return aliasTitles[left]!.localeCompare(aliasTitles[right]!);
  });

  const sortedAliasIndices = Uint32Array.from(sortedIndicesArray);
  const prefixBuckets = new Map<string, [number, number]>();

  for (let position = 0; position < sortedAliasIndices.length; position += 1) {
    const index = sortedAliasIndices[position]!;
    const key = aliasSearchKeys[index]!;
    const prefixes = new Set<string>();
    if (key.length > 0) {
      prefixes.add(key[0]!);
    }
    if (key.length > 1) {
      prefixes.add(key.slice(0, 2));
    }

    for (const prefix of prefixes) {
      const bucket = prefixBuckets.get(prefix);
      if (!bucket) {
        prefixBuckets.set(prefix, [position, position + 1]);
      } else {
        bucket[1] = position + 1;
      }
    }
  }

  return {
    canonicalTitles,
    canonicalSearchKeys,
    aliasTitles,
    aliasSearchKeys,
    aliasTargetNodeIds,
    aliasKinds,
    sortedAliasIndices,
    prefixBuckets: Object.fromEntries(prefixBuckets),
    exactAliasBuckets
  };
}

async function parseLinkTargets(
  filePath: string,
  titles: RuntimeArtifact["titles"]
): Promise<Map<number, number>> {
  const schema = await readTableSchema(filePath, "linktarget");
  const idIndex = indexOfColumn(schema, "lt_id");
  const namespaceIndex = indexOfColumn(schema, "lt_namespace");
  const titleIndex = indexOfColumn(schema, "lt_title");

  const linkTargetToNodeId = new Map<number, number>();

  await scanInsertRows(filePath, "linktarget", (row) => {
    const linkTargetId = row[idIndex];
    const namespace = row[namespaceIndex];
    const rawTitle = row[titleIndex];
    if (typeof linkTargetId !== "number" || namespace !== 0 || typeof rawTitle !== "string") {
      return;
    }

    const title = dbTitleToDisplayTitle(rawTitle);
    const aliasIndex = getBucketedLookup(titles.exactAliasBuckets, normalizeTitleForSearch(title));
    if (aliasIndex === undefined) {
      return;
    }

    linkTargetToNodeId.set(linkTargetId, titles.aliasTargetNodeIds[aliasIndex]!);
  });

  return linkTargetToNodeId;
}

interface GraphBuildResult {
  forwardOffsets: Uint32Array;
  forwardAdjacency: Uint32Array;
  reverseOffsets: Uint32Array;
  reverseAdjacency: Uint32Array;
  edgeCount: number;
}

function logPhase(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[build ${timestamp}] ${message}`);
}

function resolvePagelinkTarget(
  row: Array<string | number | null>,
  schema: SqlTableSchema,
  linkTargets: Map<number, number>,
  titles: RuntimeArtifact["titles"]
): number | null {
  const targetIdIndex = schema.columnIndex.get("pl_target_id");
  if (targetIdIndex !== undefined) {
    const linkTargetId = row[targetIdIndex];
    if (typeof linkTargetId === "number") {
      return linkTargets.get(linkTargetId) ?? null;
    }
  }

  const namespaceIndex = schema.columnIndex.get("pl_namespace");
  const titleIndex = schema.columnIndex.get("pl_title");
  if (namespaceIndex === undefined || titleIndex === undefined) {
    return null;
  }

  if (row[namespaceIndex] !== 0) {
    return null;
  }

  const rawTitle = row[titleIndex];
  if (typeof rawTitle !== "string") {
    return null;
  }

  const aliasIndex = getBucketedLookup(
    titles.exactAliasBuckets,
    normalizeTitleForSearch(dbTitleToDisplayTitle(rawTitle))
  );
  if (aliasIndex === undefined) {
    return null;
  }

  return titles.aliasTargetNodeIds[aliasIndex] ?? null;
}

async function buildGraph(
  pagelinksPath: string,
  pageIdToCanonicalNodeId: Uint32Array,
  titles: RuntimeArtifact["titles"],
  linkTargets: Map<number, number>
): Promise<GraphBuildResult> {
  const schema = await readTableSchema(pagelinksPath, "pagelinks");
  const sourceIndex = indexOfColumn(schema, "pl_from");
  const nodeCount = titles.canonicalTitles.length;
  const outDegree = new Uint32Array(nodeCount);
  const inDegree = new Uint32Array(nodeCount);

  let edgeCount = 0;

  const processRow = (row: Array<string | number | null>, onEdge: (source: number, target: number) => void) => {
    const sourcePageId = row[sourceIndex];
    if (typeof sourcePageId !== "number") {
      return;
    }

    const sourceNodeId = pageIdToCanonicalNodeId[sourcePageId];
    if (sourceNodeId === undefined || sourceNodeId === INVALID_NODE_ID) {
      return;
    }

    const targetNodeId = resolvePagelinkTarget(row, schema, linkTargets, titles);
    if (targetNodeId === null || targetNodeId === sourceNodeId) {
      return;
    }

    onEdge(sourceNodeId, targetNodeId);
  };

  await scanInsertRows(
    pagelinksPath,
    "pagelinks",
    (row) => {
      processRow(row, (sourceNodeId, targetNodeId) => {
        outDegree[sourceNodeId] = (outDegree[sourceNodeId] ?? 0) + 1;
        inDegree[targetNodeId] = (inDegree[targetNodeId] ?? 0) + 1;
        edgeCount += 1;
      });
    },
    {
      progressEveryRows: 5_000_000,
      onProgress: (rows) => {
        logPhase(`pagelinks pass 1 scanned ${rows.toLocaleString()} rows, kept ${edgeCount.toLocaleString()} edges`);
      }
    }
  );

  const forwardOffsets = new Uint32Array(nodeCount + 1);
  const reverseOffsets = new Uint32Array(nodeCount + 1);
  for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
    forwardOffsets[nodeId + 1] = (forwardOffsets[nodeId] ?? 0) + (outDegree[nodeId] ?? 0);
    reverseOffsets[nodeId + 1] = (reverseOffsets[nodeId] ?? 0) + (inDegree[nodeId] ?? 0);
  }

  const forwardAdjacency = new Uint32Array(edgeCount);
  const reverseAdjacency = new Uint32Array(edgeCount);
  const forwardCursor = forwardOffsets.slice();
  const reverseCursor = reverseOffsets.slice();

  let writtenEdges = 0;
  await scanInsertRows(
    pagelinksPath,
    "pagelinks",
    (row) => {
      processRow(row, (sourceNodeId, targetNodeId) => {
        const forwardPosition = forwardCursor[sourceNodeId]!;
        const reversePosition = reverseCursor[targetNodeId]!;
        forwardAdjacency[forwardPosition] = targetNodeId;
        forwardCursor[sourceNodeId] = forwardPosition + 1;
        reverseAdjacency[reversePosition] = sourceNodeId;
        reverseCursor[targetNodeId] = reversePosition + 1;
        writtenEdges += 1;
      });
    },
    {
      progressEveryRows: 5_000_000,
      onProgress: (rows) => {
        logPhase(`pagelinks pass 2 scanned ${rows.toLocaleString()} rows, wrote ${writtenEdges.toLocaleString()} edges`);
      }
    }
  );

  return {
    forwardOffsets,
    forwardAdjacency,
    reverseOffsets,
    reverseAdjacency,
    edgeCount
  };
}

function persistArtifact(artifact: RuntimeArtifact): void {
  fs.rmSync(appConfig.artifactRootDir, { recursive: true, force: true });
  fs.mkdirSync(appConfig.artifactRootDir, { recursive: true });

  const manifest: PersistedArtifactManifest = {
    version: artifact.version,
    builtAt: artifact.builtAt,
    dumpFiles: artifact.dumpFiles,
    counts: artifact.counts,
    prefixBuckets: artifact.titles.prefixBuckets,
    chunks: {
      canonicalTitles: writeStringChunks("canonical-titles", artifact.titles.canonicalTitles),
      canonicalSearchKeys: writeStringChunks("canonical-search-keys", artifact.titles.canonicalSearchKeys),
      aliasTitles: writeStringChunks("alias-titles", artifact.titles.aliasTitles),
      aliasSearchKeys: writeStringChunks("alias-search-keys", artifact.titles.aliasSearchKeys),
      aliasTargetNodeIds: writeUint32Chunks("alias-target-node-ids", artifact.titles.aliasTargetNodeIds),
      aliasKinds: writeUint8Chunks("alias-kinds", artifact.titles.aliasKinds),
      sortedAliasIndices: writeUint32Chunks("sorted-alias-indices", artifact.titles.sortedAliasIndices),
      forwardOffsets: writeUint32Chunks("forward-offsets", artifact.graph.forwardOffsets),
      forwardAdjacency: writeUint32Chunks("forward-adjacency", artifact.graph.forwardAdjacency),
      reverseOffsets: writeUint32Chunks("reverse-offsets", artifact.graph.reverseOffsets),
      reverseAdjacency: writeUint32Chunks("reverse-adjacency", artifact.graph.reverseAdjacency)
    }
  };

  fs.writeFileSync(appConfig.artifactPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    appConfig.artifactMetaPath,
    JSON.stringify(
      {
        version: artifact.version,
        builtAt: artifact.builtAt,
        counts: artifact.counts,
        dumpFiles: artifact.dumpFiles
      },
      null,
      2
    )
  );
}

function writeStringChunks(baseName: string, values: string[], chunkSize = 1_000_000): ChunkManifest {
  const files: string[] = [];
  for (let start = 0, part = 0; start < values.length; start += chunkSize, part += 1) {
    const filename = `${baseName}.${part}.v8`;
    files.push(filename);
    fs.writeFileSync(
      path.join(appConfig.artifactRootDir, filename),
      v8.serialize(values.slice(start, Math.min(values.length, start + chunkSize)))
    );
  }

  return {
    kind: "string",
    length: values.length,
    files
  };
}

function writeUint32Chunks(baseName: string, values: Uint32Array, chunkSize = 100_000_000): ChunkManifest {
  const files: string[] = [];
  for (let start = 0, part = 0; start < values.length; start += chunkSize, part += 1) {
    const filename = `${baseName}.${part}.bin`;
    const slice = values.subarray(start, Math.min(values.length, start + chunkSize));
    files.push(filename);
    fs.writeFileSync(
      path.join(appConfig.artifactRootDir, filename),
      Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength)
    );
  }

  return {
    kind: "u32",
    length: values.length,
    files
  };
}

function writeUint8Chunks(baseName: string, values: Uint8Array, chunkSize = 250_000_000): ChunkManifest {
  const files: string[] = [];
  for (let start = 0, part = 0; start < values.length; start += chunkSize, part += 1) {
    const filename = `${baseName}.${part}.bin`;
    const slice = values.subarray(start, Math.min(values.length, start + chunkSize));
    files.push(filename);
    fs.writeFileSync(
      path.join(appConfig.artifactRootDir, filename),
      Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength)
    );
  }

  return {
    kind: "u8",
    length: values.length,
    files
  };
}

export async function buildRuntimeArtifact(dumps: DumpPaths = requireDumpPaths()): Promise<RuntimeArtifact> {
  fs.mkdirSync(path.dirname(appConfig.artifactPath), { recursive: true });
  const dumpFiles = statDumpFiles(dumps);

  logPhase("starting page parse");
  const pagePass = await parsePageDump(dumps.page);
  logPhase(
    `page parse complete: ${pagePass.canonicalTitles.length.toLocaleString()} canonical nodes, ${pagePass.mainspacePageCount.toLocaleString()} ns=0 pages`
  );
  logPhase("starting redirect parse");
  const redirectPass = await parseRedirectDump(dumps.redirect, pagePass);
  logPhase(`redirect parse complete: ${redirectPass.redirectCount.toLocaleString()} redirects`);
  const redirectAliases = resolveRedirectAliases(pagePass, redirectPass.redirectTargetPageIdBySource);
  logPhase(`redirect resolution complete: ${redirectAliases.length.toLocaleString()} redirect aliases`);
  const titles = buildAliasIndexes(pagePass.canonicalTitles, pagePass.canonicalSearchKeys, redirectAliases);
  logPhase(`title indexes complete: ${titles.aliasTitles.length.toLocaleString()} total aliases`);
  logPhase("starting linktarget parse");
  const linkTargets = await parseLinkTargets(dumps.linktarget, titles);
  logPhase(`linktarget parse complete: ${linkTargets.size.toLocaleString()} mainspace link targets resolved`);
  logPhase("starting pagelinks graph build");
  const graph = await buildGraph(dumps.pagelinks, pagePass.pageIdToCanonicalNodeId, titles, linkTargets);
  logPhase(`graph build complete: ${graph.edgeCount.toLocaleString()} directed edges`);

  const artifact: RuntimeArtifact = {
    version: appConfig.buildVersion,
    builtAt: new Date().toISOString(),
    dumpFiles,
    counts: {
      canonicalNodes: titles.canonicalTitles.length,
      aliases: titles.aliasTitles.length,
      redirects: redirectAliases.length,
      edges: graph.edgeCount
    },
    graph: {
      forwardOffsets: graph.forwardOffsets,
      forwardAdjacency: graph.forwardAdjacency,
      reverseOffsets: graph.reverseOffsets,
      reverseAdjacency: graph.reverseAdjacency
    },
    titles
  };

  persistArtifact(artifact);
  logPhase(`artifact persisted to ${appConfig.artifactPath}`);
  return artifact;
}

export function getBuildReadiness(): {
  ready: boolean;
  artifactPath: string;
  missingDumps: string[];
  discoveredDumps: Partial<DumpPaths>;
} {
  const discovery = discoverDumpPaths();
  return {
    ready: fs.existsSync(appConfig.artifactPath),
    artifactPath: appConfig.artifactPath,
    missingDumps: discovery.missing,
    discoveredDumps: discovery.dumps
  };
}
