# Zeth backend

Smart contracts of Zeth, built with Hardhat 3. Tests use `mocha` and ethers.js.

## ShieldedPool

`ShieldedPool` holds a single ERC-20 token and keeps track of **notes**. A note is a tuple `(pk, amount, nonce)`:

- `pk = Poseidon(DS_SK, sk)` is the owner's public key, derived from a secret key `sk`.
- `amount` is an amount of tokens, at most `2^64 - 1`.
- `nonce` is a random number that makes each note unique.

The contract only stores the **commitment** of each note, `cm = Poseidon(DS_CMT, pk, amount, nonce)`, and rejects a commitment that already exists. Spending a note requires its secret key (`pk` must equal `Poseidon(DS_SK, sk)`) and reveals its **nullifier** `nf = Poseidon(DS_NF, cm, sk)`. The contract stores the nullifiers it has seen and rejects any nullifier revealed twice, which prevents double spending.

| Function                               | What it does                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `shield(note)`                         | Deposits `note.amount` tokens and creates `note`.                              |
| `privateTransfer(sk, inputs, outputs)` | Spends two notes owned by `sk` and creates two notes of the same total amount. |
| `unshield(sk, note, receiver)`         | Spends `note` and sends its whole amount to `receiver`.                        |

> **⚠️ Work in progress:** for now, spending a note reveals `sk`, `amount` and `nonce` in the transaction. Anyone who sees them can spend all the notes of that key. Zero-knowledge proofs will remove this.

> **Compute keys and nullifiers locally.** `derivePublicKey(sk)` and `computeNullifier(cm, sk)` are public functions of the contract, but a client must never call them through an RPC node: the call would send `sk` to the node provider, even without a transaction. Clients should compute them locally with a JavaScript Poseidon implementation. The tests call these functions only because they run on a local Hardhat network.

> **Shields can be front-run.** A pending `shield(note)` is visible in the mempool. Anyone can send the same call first: the victim's transaction then reverts with `DuplicateCommitment`. The attacker gains nothing, since they pay the deposit themselves and the note goes to the victim's `pk`. The victim only has to retry with a new nonce. This stays true once zero-knowledge proofs are added, because shields are public by design.
>
> For now, a pending `privateTransfer` can be blocked the same way: its outputs `(pk, amount, nonce)` are visible, so anyone can `shield` one of them first. This will disappear with zero-knowledge proofs, since outputs will only be commitments.

### Events

| Event                                        | Emitted by       | Use                                                                                             |
| -------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `NoteCreated(commitment, pk, amount, nonce)` | every new note   | Lets the owner find the notes sent to their `pk` (indexed) and everything needed to spend them. |
| `NullifierRevealed(nullifier)`               | every spent note | Lets the owner check whether one of their notes has been spent.                                 |
| `Shielded(from, pk, amount, nonce)`          | `shield`         | A deposit, with the full note.                                                                  |
| `Unshielded(to, amount)`                     | `unshield`       | A withdrawal.                                                                                   |

### Poseidon libraries

Poseidon hashes come from [`poseidon-solidity`](https://github.com/vimwitch/poseidon-solidity). `PoseidonT3` (2 inputs), `PoseidonT4` (3 inputs) and `PoseidonT5` (4 inputs) are external libraries: they are too large to be copied into `ShieldedPool`, so each one is deployed on its own and linked to the pool at deployment. They are listed in `npmFilesToBuild` in `hardhat.config.ts` so that Hardhat compiles them.

## Supported tokens

A `ShieldedPool` accepts a single ERC-20 token, fixed at deployment. Only standard ERC-20 tokens are supported (e.g. DAI, WETH):

- **Fee-on-transfer tokens** are rejected: `shield` checks that the pool received exactly the deposited amount.
- **Tokens that can enable a fee later** (e.g. USDT) and **rebasing tokens** (e.g. stETH, whose balances change without a transfer) are not supported. The pool could end up holding fewer tokens than the total amount of its notes, and the last notes could never be unshielded. `unshield` does not check the amount that leaves the pool: if it reverted instead, the funds would be stuck anyway.
- **Tokens with transfer hooks** (ERC-777) are not supported.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

### Make a deployment to Sepolia

This project includes an Ignition module, `ignition/modules/ShieldedPool.ts`, that deploys a test token (`MockERC20`, mintable by anyone), the Poseidon libraries and a `ShieldedPool` linked to them. The same module is used locally and on Sepolia.

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
