import { buildRuntimeArtifact } from "./builder.js";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const artifact = await buildRuntimeArtifact();
  const durationMs = Date.now() - startedAt;

  console.log(
    JSON.stringify(
      {
        builtAt: artifact.builtAt,
        durationMs,
        counts: artifact.counts
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
