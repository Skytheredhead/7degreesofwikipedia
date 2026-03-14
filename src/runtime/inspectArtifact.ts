import { WikiGraphRuntime } from "./graphEngine.js";

const runtime = WikiGraphRuntime.loadFromDisk();
console.log(JSON.stringify(runtime.artifactSummary(), null, 2));
