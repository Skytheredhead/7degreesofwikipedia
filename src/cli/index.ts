import { WikiService } from "../services/wikiService.js";

function printHelp(): void {
  console.log(`Usage:
  npm run cli -- status [--json]
  npm run cli -- suggest <query> [limit] [--json]
  npm run cli -- resolve <title> [--json]
  npm run cli -- path <from> <to> [--json]
  npm run cli -- stats <overview|session|lifetime|performance|recent|top|connectors|leaderboard> [--json]
  npm run cli -- smoke [<from> <to>] [--json]
`);
}

function hasJsonFlag(args: string[]): boolean {
  return args.includes("--json");
}

function stripFlags(args: string[]): string[] {
  return args.filter((arg) => arg !== "--json");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printPathResult(result: Record<string, unknown>): void {
  const payload = result as {
    searchId: string;
    searchedAt: string;
    request: { from: string; to: string };
    resolution: {
      redirectsApplied: boolean;
      from: {
        found: boolean;
        result: { canonicalTitle: string; matchedTitle: string; viaRedirect: boolean } | null;
      };
      to: {
        found: boolean;
        result: { canonicalTitle: string; matchedTitle: string; viaRedirect: boolean } | null;
      };
    };
    success: boolean;
    found: boolean;
    failureReason: string | null;
    cached: boolean;
    totalRoutesFound: string | null;
    displayedRoutes: number;
    routes: Array<{
      routeIndex: number;
      pathNodes: Array<{
        position: number;
        displayTitle: string;
        wikipediaUrl: string;
        role: string;
      }>;
    }> | null;
    pathLength: number | null;
    pathNodes: Array<{
      position: number;
      displayTitle: string;
      wikipediaUrl: string;
      role: string;
    }> | null;
    metrics: {
      durationMs: number;
      nodesVisited: number;
      nodesExpanded: number;
      frontierExpansions: number;
    };
  };

  console.log(`Search ID: ${payload.searchId}`);
  console.log(`Searched at: ${payload.searchedAt}`);
  console.log(
    `From: ${payload.request.from} -> ${payload.resolution.from.result?.canonicalTitle ?? "[unresolved]"}`
  );
  console.log(
    `To:   ${payload.request.to} -> ${payload.resolution.to.result?.canonicalTitle ?? "[unresolved]"}`
  );
  console.log(`Found: ${payload.found ? "yes" : "no"}`);
  console.log(`Success: ${payload.success ? "yes" : "no"}`);
  console.log(`Failure reason: ${payload.failureReason ?? "n/a"}`);
  console.log(`Redirects applied: ${payload.resolution.redirectsApplied ? "yes" : "no"}`);
  console.log(`Cache hit: ${payload.cached ? "yes" : "no"}`);
  console.log(`Duration: ${payload.metrics.durationMs.toFixed(2)} ms`);
  console.log(`Path length: ${payload.pathLength ?? "n/a"}`);
  console.log(
    `Shortest routes: ${payload.totalRoutesFound ?? "0"} total, showing ${payload.displayedRoutes}`
  );
  console.log(
    `Traversal: visited=${payload.metrics.nodesVisited}, expanded=${payload.metrics.nodesExpanded}, frontierExpansions=${payload.metrics.frontierExpansions}`
  );

  if (payload.routes && payload.routes.length > 0) {
    console.log("");
    console.log("Routes:");
    for (const route of payload.routes) {
      console.log(`  Route ${route.routeIndex + 1}:`);
      for (const node of route.pathNodes) {
        console.log(`    ${node.position}. ${node.displayTitle} [${node.role}]`);
        console.log(`       ${node.wikipediaUrl}`);
      }
    }
  }
}

function printSmokeResult(result: Record<string, unknown>): void {
  const payload = result as {
    readiness: Record<string, unknown>;
    resolution: {
      from: Record<string, unknown>;
      to: Record<string, unknown>;
    };
    search: Record<string, unknown>;
    stats: {
      lifetime: {
        summary: {
          totals: {
            totalSearches: number;
            successfulSearches: number;
            failedSearches: number;
            averageDurationMs: number | null;
          };
        };
      };
    };
  };

  console.log("Readiness:");
  printJson(payload.readiness);
  console.log("");
  console.log("Resolution:");
  printJson(payload.resolution);
  console.log("");
  printPathResult(payload.search);
  console.log("");
  console.log("Lifetime totals:");
  printJson(payload.stats.lifetime.summary.totals);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const json = hasJsonFlag(rawArgs);
  const args = stripFlags(rawArgs);
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const wiki = await WikiService.bootstrap();
  let output: unknown;

  switch (command) {
    case "status":
      output = wiki.status();
      break;
    case "suggest": {
      const query = rest[0];
      if (!query) {
        throw new Error("suggest requires a query");
      }
      const limit = rest[1] ? Number(rest[1]) : undefined;
      output = wiki.suggestTitles(query, limit);
      break;
    }
    case "resolve": {
      const title = rest[0];
      if (!title) {
        throw new Error("resolve requires a title");
      }
      output = wiki.resolveTitle(title);
      break;
    }
    case "path": {
      const from = rest[0];
      const to = rest[1];
      if (!from || !to) {
        throw new Error("path requires both <from> and <to>");
      }
      output = wiki.searchPath(from, to);
      break;
    }
    case "stats": {
      const scope = rest[0] ?? "overview";
      switch (scope) {
        case "overview":
          output = wiki.statsOverview();
          break;
        case "session":
        case "lifetime":
          output = wiki.statsSummary(scope);
          break;
        case "performance":
          output = wiki.performanceSummary("lifetime");
          break;
        case "recent":
          output = wiki.recentSearches();
          break;
        case "top":
          output = wiki.topSearches();
          break;
        case "connectors":
          output = wiki.topConnectors();
          break;
        case "leaderboard":
          output = wiki.leaderboard();
          break;
        default:
          throw new Error(`unknown stats view: ${scope}`);
      }
      break;
    }
    case "smoke": {
      const from = rest[0] ?? "Kevin Bacon";
      const to = rest[1] ?? "Philosophy";
      output = {
        readiness: wiki.readiness(),
        resolution: {
          from: wiki.resolveTitle(from),
          to: wiki.resolveTitle(to)
        },
        search: wiki.searchPath(from, to),
        stats: {
          session: wiki.statsSummary("session"),
          lifetime: wiki.statsSummary("lifetime")
        }
      };
      break;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }

  if (json) {
    printJson(output);
    return;
  }

  if (command === "path") {
    printPathResult(output as Record<string, unknown>);
    return;
  }

  if (command === "smoke") {
    printSmokeResult(output as Record<string, unknown>);
    return;
  }

  printJson(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
