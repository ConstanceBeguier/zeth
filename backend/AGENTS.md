# Hardhat + ethers project

## Project layout

```
contracts/        Solidity source files (*.sol), test-only contracts in contracts/mocks/
test/             TypeScript tests (ethers + Mocha + Chai), no Solidity tests
ignition/         Hardhat Ignition deployment modules
scripts/          Standalone scripts run with `hardhat run`
hardhat.config.ts
```

## Working in this project

All tests are written in TypeScript with ethers, Mocha and Chai, in `test/`. Do not write Solidity tests (`*.t.sol`), even though the `hardhat` skill below presents them as the default choice for unit tests.

When writing or modifying tests, configuring `hardhat.config.ts`, or interacting with the network from TypeScript, invoke the **`hardhat`** skill. It covers Solidity and TypeScript testing, how to choose between them, `forge-std` cheatcodes, the `network.create()` API, `networkHelpers`, and the compile-then-typecheck workflow. The skill itself points to the matching `hardhat-toolbox-*` skill for toolbox-specific guidance (signers, contract interaction, assertions).

## Docs

- Hardhat 3 — https://hardhat.org/llms.txt
- ethers.js — https://docs.ethers.org/v6/
