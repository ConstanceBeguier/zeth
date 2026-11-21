/**
 * Checks that every compiled contract stays under the EVM size limits:
 *   - EIP-170:  deployed (runtime) bytecode <= 24 576 bytes
 *   - EIP-3860: init code                   <= 49 152 bytes
 *
 * Run after `hardhat compile --build-profile production` so that sizes match
 * what would actually be deployed (optimizer enabled).
 *
 * Usage: node scripts/check-contract-size.ts [--warn-at <percent>]
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_LIMIT = 24_576;
const INITCODE_LIMIT = 49_152;
const ARTIFACTS_DIR = "artifacts/contracts";

const warnFlag = process.argv.indexOf("--warn-at");
const WARN_AT_PERCENT =
  warnFlag !== -1 ? Number(process.argv[warnFlag + 1]) : 90;

interface Artifact {
  contractName: string;
  sourceName: string;
  bytecode: string;
  deployedBytecode: string;
}

interface Row {
  name: string;
  runtime: number;
  initcode: number;
}

function findArtifacts(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return findArtifacts(path);
    return entry.endsWith(".json") && !entry.endsWith(".dbg.json")
      ? [path]
      : [];
  });
}

const byteLength = (hex: string) => (hex.replace(/^0x/, "").length / 2) | 0;
const pct = (size: number, limit: number) => (100 * size) / limit;

const rows: Row[] = findArtifacts(ARTIFACTS_DIR)
  .map((file) => JSON.parse(readFileSync(file, "utf8")) as Artifact)
  // Skip Solidity test contracts and abstract contracts/interfaces (no bytecode)
  .filter((a) => !a.sourceName.endsWith(".t.sol"))
  // Skip test-only contracts, which are never deployed in production
  .filter((a) => !a.sourceName.startsWith("contracts/mocks/"))
  .filter((a) => byteLength(a.deployedBytecode) > 0)
  .map((a) => ({
    name: `${a.sourceName}:${a.contractName}`,
    runtime: byteLength(a.deployedBytecode),
    initcode: byteLength(a.bytecode),
  }))
  .sort((a, b) => b.runtime - a.runtime);

if (rows.length === 0) {
  console.error(
    `No artifacts found in ${ARTIFACTS_DIR}. Did you run \`hardhat compile\`?`,
  );
  process.exit(1);
}

let failed = false;
const lines = [
  "| Contract | Runtime (EIP-170) | Init code (EIP-3860) | Status |",
  "|---|---|---|---|",
];

for (const { name, runtime, initcode } of rows) {
  const runtimePct = pct(runtime, RUNTIME_LIMIT);
  const initPct = pct(initcode, INITCODE_LIMIT);
  const maxPct = Math.max(runtimePct, initPct);

  let status = "✅";
  if (runtime > RUNTIME_LIMIT || initcode > INITCODE_LIMIT) {
    status = "❌ over limit";
    failed = true;
    console.log(`::error::${name} exceeds the contract size limit`);
  } else if (maxPct >= WARN_AT_PERCENT) {
    status = `⚠️ ≥ ${WARN_AT_PERCENT}%`;
    console.log(`::warning::${name} is at ${maxPct.toFixed(1)}% of the limit`);
  }

  lines.push(
    `| \`${name}\` | ${runtime} B (${runtimePct.toFixed(1)}%) | ${initcode} B (${initPct.toFixed(1)}%) | ${status} |`,
  );
}

const report = ["### Contract sizes", "", ...lines, ""].join("\n");
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
}

process.exit(failed ? 1 : 0);
