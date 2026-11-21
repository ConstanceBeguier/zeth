# Sample Hardhat 3 Project (`mocha` and `ethers`)

This project showcases a Hardhat 3 project using `mocha` for tests and the `ethers` library for Ethereum interactions.

To learn more about Hardhat 3, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3](https://hardhat.org/hardhat3-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- TypeScript tests using `mocha` and ethers.js (there are no Solidity tests).
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Supported tokens

A `ShieldedPool` accepts a single ERC-20 token, fixed at deployment. Only standard ERC-20 tokens are supported (e.g. DAI, WETH):

- **Fee-on-transfer tokens** are rejected: `shield` checks that the pool received exactly the deposited amount.
- **Tokens that can enable a fee later** (e.g. USDT) and **rebasing tokens** (e.g. stETH, whose balances change without a transfer) are not supported. The pool could end up holding fewer tokens than the total value of its notes, and the last notes could never be unshielded. `unshield` does not check the amount that leaves the pool: if it reverted instead, the funds would be stuck anyway.
- **Tokens with transfer hooks** (ERC-777) are not supported.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

### Make a deployment to Sepolia

This project includes an Ignition module, `ignition/modules/ShieldedPool.ts`, that deploys a test token (`MockERC20`, mintable by anyone) and a `ShieldedPool` for it. The same module is used locally and on Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/ShieldedPool.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/ShieldedPool.ts
```
