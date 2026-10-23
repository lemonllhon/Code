import { writeFile } from "node:fs/promises";
import { makeRequestContextQualityFixtures } from "./request-context-quality-fixtures.js";
const output = process.argv[2];
if (!output) throw new Error("Pass the synthetic fixture output file");
await writeFile(
  output,
  `${JSON.stringify(makeRequestContextQualityFixtures(), null, 2)}\n`,
  "utf8",
);
