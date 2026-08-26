import { rebuildFirstMeasureProjectIndex } from "../../firstmeasure/project_index.js";

async function main() {
  const result = await rebuildFirstMeasureProjectIndex();
  process.stdout.write([
    "FirstMeasure project index rebuilt.",
    `DB: ${result.dbPath}`,
    `Projects indexed: ${result.indexedProjects}`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`
  ].join("\n") + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
