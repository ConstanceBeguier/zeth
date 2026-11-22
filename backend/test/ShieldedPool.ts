import { expect } from "chai";
import { network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type {
  MockERC20,
  ShieldedPool,
} from "../types/ethers-contracts/index.js";

const { ethers } = await network.create();

const MAX_VALUE = 2n ** 64n - 1n;
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Secret keys of Alice and Bob
const ALICE_SK = 111n;
const BOB_SK = 222n;

// Deploys the Poseidon libraries and a pool for `tokenAddress`, linked to them
async function deployPool(tokenAddress: string): Promise<ShieldedPool> {
  const poseidonT3 = await ethers.deployContract("PoseidonT3");
  const poseidonT5 = await ethers.deployContract("PoseidonT5");
  return ethers.deployContract("ShieldedPool", [tokenAddress], {
    libraries: {
      PoseidonT3: await poseidonT3.getAddress(),
      PoseidonT5: await poseidonT5.getAddress(),
    },
  });
}

describe("ShieldedPool", function () {
  let token: MockERC20;
  let pool: ShieldedPool;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let alicePk: bigint;
  let bobPk: bigint;

  // Before every test: a fresh token and pool, and 1000 tokens for Alice and
  // Bob, both of whom approve the pool
  beforeEach(async function () {
    [alice, bob, carol] = await ethers.getSigners();

    token = await ethers.deployContract("MockERC20");
    pool = await deployPool(await token.getAddress());

    for (const user of [alice, bob]) {
      await token.mint(user.address, 1000n);
      await token.connect(user).approve(await pool.getAddress(), 1000n);
    }

    alicePk = await pool.derivePublicKey(ALICE_SK);
    bobPk = await pool.derivePublicKey(BOB_SK);
  });

  describe("deployment", function () {
    it("Should store the token address", async function () {
      expect(await pool.TOKEN()).to.equal(await token.getAddress());
    });

    it("Should revert if the token is the zero address", async function () {
      await expect(
        deployPool(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("keys", function () {
    it("Should give different public keys to different secret keys", async function () {
      expect(alicePk).to.not.equal(bobPk);
    });

    it("Should revert if the secret key is not smaller than the field size", async function () {
      await expect(
        pool.derivePublicKey(FIELD_SIZE),
      ).to.be.revertedWithCustomError(pool, "InvalidSecretKey");
    });
  });

  describe("shield", function () {
    it("Should create a note, move the tokens and emit events", async function () {
      const commitment = await pool.computeCommitment(bobPk, 100n, 1n);

      const tx = pool.connect(alice).shield(bobPk, 100n, 1n);

      await expect(tx)
        .to.emit(pool, "NoteCreated")
        .withArgs(commitment, bobPk, 100n, 1n)
        .and.to.emit(pool, "Shielded")
        .withArgs(alice.address, bobPk, 100n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [alice, pool],
        [-100n, 100n],
      );

      expect(await pool.commitments(commitment)).to.equal(true);
      expect(await pool.spentCommitments(commitment)).to.equal(false);
    });

    it("Should revert if the same note is shielded twice", async function () {
      await pool.shield(alicePk, 100n, 1n);

      await expect(
        pool.shield(alicePk, 100n, 1n),
      ).to.be.revertedWithCustomError(pool, "DuplicateCommitment");
    });

    it("Should revert if the value is 0", async function () {
      await expect(pool.shield(alicePk, 0n, 1n)).to.be.revertedWithCustomError(
        pool,
        "InvalidValue",
      );
    });

    it("Should revert if the value is greater than 2^64 - 1", async function () {
      await expect(
        pool.shield(alicePk, MAX_VALUE + 1n, 1n),
      ).to.be.revertedWithCustomError(pool, "InvalidValue");
    });

    it("Should revert if the public key is 0", async function () {
      await expect(pool.shield(0n, 100n, 1n)).to.be.revertedWithCustomError(
        pool,
        "InvalidPublicKey",
      );
    });

    it("Should revert if the public key is not smaller than the field size", async function () {
      await expect(
        pool.shield(FIELD_SIZE, 100n, 1n),
      ).to.be.revertedWithCustomError(pool, "InvalidPublicKey");
    });

    it("Should revert if the nonce is not smaller than the field size", async function () {
      await expect(
        pool.shield(alicePk, 100n, FIELD_SIZE),
      ).to.be.revertedWithCustomError(pool, "InvalidNonce");
    });

    it("Should revert without enough allowance", async function () {
      // Alice has 2000 tokens but only approved 1000: the allowance is the
      // only thing that is missing
      await token.mint(alice.address, 1000n);

      await expect(
        pool.shield(alicePk, 1001n, 1n),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });

    it("Should reject a fee-on-transfer token", async function () {
      const feeToken = await ethers.deployContract("FeeOnTransferERC20");
      const feePool = await deployPool(await feeToken.getAddress());
      await feeToken.mint(alice.address, 1000n);
      await feeToken.approve(await feePool.getAddress(), 1000n);

      await expect(
        feePool.shield(alicePk, 100n, 1n),
      ).to.be.revertedWithCustomError(feePool, "UnsupportedToken");
    });
  });

  describe("privateTransfer", function () {
    // Alice owns two notes: 60 tokens (nonce 1) and 40 tokens (nonce 2)
    const ALICE_NOTES = [
      { value: 60n, nonce: 1n },
      { value: 40n, nonce: 2n },
    ];

    beforeEach(async function () {
      for (const note of ALICE_NOTES) {
        await pool.shield(alicePk, note.value, note.nonce);
      }
    });

    type Input = { value: bigint; nonce: bigint };
    type Output = { pk: bigint; value: bigint; nonce: bigint };

    // Spends `inputs` with Alice's secret key (unless `sk` is given) and
    // creates `outputs`
    function transfer(
      inputs: [Input, Input],
      outputs: [Output, Output],
      sk = ALICE_SK,
    ) {
      return pool.privateTransfer(sk, inputs, outputs);
    }

    it("Should spend the inputs, create the outputs and emit events", async function () {
      const outputs: [Output, Output] = [
        { pk: bobPk, value: 70n, nonce: 3n },
        { pk: alicePk, value: 30n, nonce: 4n },
      ];
      const inputCommitments = [
        await pool.computeCommitment(alicePk, 60n, 1n),
        await pool.computeCommitment(alicePk, 40n, 2n),
      ];
      const outputCommitments = [
        await pool.computeCommitment(bobPk, 70n, 3n),
        await pool.computeCommitment(alicePk, 30n, 4n),
      ];

      const tx = transfer([ALICE_NOTES[0], ALICE_NOTES[1]], outputs);

      await expect(tx)
        .to.emit(pool, "NoteSpent")
        .withArgs(inputCommitments[0])
        .and.to.emit(pool, "NoteSpent")
        .withArgs(inputCommitments[1])
        .and.to.emit(pool, "NoteCreated")
        .withArgs(outputCommitments[0], bobPk, 70n, 3n)
        .and.to.emit(pool, "NoteCreated")
        .withArgs(outputCommitments[1], alicePk, 30n, 4n);
      // A private transfer never moves tokens
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [alice, bob, pool],
        [0n, 0n, 0n],
      );

      for (const commitment of inputCommitments) {
        expect(await pool.spentCommitments(commitment)).to.equal(true);
      }
      for (const commitment of outputCommitments) {
        expect(await pool.commitments(commitment)).to.equal(true);
        expect(await pool.spentCommitments(commitment)).to.equal(false);
      }
    });

    it("Should allow an output of value 0", async function () {
      await transfer(
        [ALICE_NOTES[0], ALICE_NOTES[1]],
        [
          { pk: bobPk, value: 100n, nonce: 3n },
          { pk: alicePk, value: 0n, nonce: 4n },
        ],
      );

      const commitment = await pool.computeCommitment(alicePk, 0n, 4n);
      expect(await pool.commitments(commitment)).to.equal(true);
    });

    it("Should revert if the same note is used twice", async function () {
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[0]],
          [
            { pk: bobPk, value: 60n, nonce: 3n },
            { pk: bobPk, value: 60n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "DuplicateInput");
    });

    it("Should revert with the wrong secret key", async function () {
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[1]],
          [
            { pk: bobPk, value: 100n, nonce: 3n },
            { pk: bobPk, value: 0n, nonce: 4n },
          ],
          BOB_SK,
        ),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if an input does not exist", async function () {
      // Alice has no note of 60 tokens with nonce 99
      await expect(
        transfer(
          [{ value: 60n, nonce: 99n }, ALICE_NOTES[1]],
          [
            { pk: bobPk, value: 100n, nonce: 3n },
            { pk: bobPk, value: 0n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if an input is already spent", async function () {
      await transfer(
        [ALICE_NOTES[0], ALICE_NOTES[1]],
        [
          { pk: alicePk, value: 100n, nonce: 3n },
          { pk: alicePk, value: 0n, nonce: 4n },
        ],
      );

      await expect(
        transfer(
          [ALICE_NOTES[0], { value: 100n, nonce: 3n }],
          [
            { pk: bobPk, value: 160n, nonce: 5n },
            { pk: bobPk, value: 0n, nonce: 6n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should revert if inputs and outputs are not balanced", async function () {
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[1]],
          [
            { pk: bobPk, value: 100n, nonce: 3n },
            { pk: bobPk, value: 1n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "UnbalancedTransfer");
    });

    it("Should revert if an input value is not a valid value", async function () {
      // 60 + FIELD_SIZE has the same commitment as 60 (Poseidon works modulo
      // FIELD_SIZE): without the value check, this would create tokens
      await expect(
        transfer(
          [{ value: 60n + FIELD_SIZE, nonce: 1n }, ALICE_NOTES[1]],
          [
            { pk: bobPk, value: MAX_VALUE, nonce: 3n },
            { pk: bobPk, value: 0n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidValue");
    });

    it("Should revert if an output value is greater than 2^64 - 1", async function () {
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[1]],
          [
            { pk: bobPk, value: MAX_VALUE + 1n, nonce: 3n },
            { pk: bobPk, value: 0n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidValue");
    });

    it("Should revert if an output public key is 0", async function () {
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[1]],
          [
            { pk: 0n, value: 100n, nonce: 3n },
            { pk: bobPk, value: 0n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidPublicKey");
    });

    it("Should revert if the two outputs are the same note", async function () {
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[1]],
          [
            { pk: bobPk, value: 50n, nonce: 3n },
            { pk: bobPk, value: 50n, nonce: 3n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "DuplicateCommitment");
    });

    it("Should revert if an output already exists, even if spent", async function () {
      // The output is the note being spent: its commitment already exists
      await expect(
        transfer(
          [ALICE_NOTES[0], ALICE_NOTES[1]],
          [
            { pk: alicePk, value: 60n, nonce: 1n },
            { pk: alicePk, value: 40n, nonce: 3n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "DuplicateCommitment");
    });
  });

  describe("unshield", function () {
    // Alice owns a note of 100 tokens (nonce 1)
    beforeEach(async function () {
      await pool.shield(alicePk, 100n, 1n);
    });

    it("Should send the note's value to the receiver and emit events", async function () {
      const commitment = await pool.computeCommitment(alicePk, 100n, 1n);

      const tx = pool.unshield(ALICE_SK, 1n, carol.address, 100n);

      await expect(tx)
        .to.emit(pool, "NoteSpent")
        .withArgs(commitment)
        .and.to.emit(pool, "Unshielded")
        .withArgs(carol.address, 100n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [pool, carol],
        [-100n, 100n],
      );

      expect(await pool.spentCommitments(commitment)).to.equal(true);
    });

    it("Should let anyone who knows the secret key spend the note", async function () {
      // The secret key is public for now: Bob can steal Alice's note
      await expect(
        pool.connect(bob).unshield(ALICE_SK, 1n, bob.address, 100n),
      ).to.changeTokenBalances(ethers, token, [pool, bob], [-100n, 100n]);
    });

    it("Should revert when unshielding the same note twice", async function () {
      await pool.unshield(ALICE_SK, 1n, alice.address, 100n);

      await expect(
        pool.unshield(ALICE_SK, 1n, alice.address, 100n),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should unshield a note of value 0", async function () {
      // Alice shields a second note, then turns both into 150 + 0
      await pool.shield(alicePk, 50n, 2n);
      await pool.privateTransfer(
        ALICE_SK,
        [
          { value: 100n, nonce: 1n },
          { value: 50n, nonce: 2n },
        ],
        [
          { pk: alicePk, value: 150n, nonce: 3n },
          { pk: alicePk, value: 0n, nonce: 4n },
        ],
      );

      const tx = pool.unshield(ALICE_SK, 4n, carol.address, 0n);

      await expect(tx).to.emit(pool, "Unshielded").withArgs(carol.address, 0n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [pool, carol],
        [0n, 0n],
      );
    });

    it("Should revert with the wrong secret key", async function () {
      await expect(
        pool.unshield(BOB_SK, 1n, bob.address, 100n),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if the amount is not the note's value", async function () {
      await expect(
        pool.unshield(ALICE_SK, 1n, alice.address, 50n),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if the receiver is the zero address", async function () {
      await expect(
        pool.unshield(ALICE_SK, 1n, ethers.ZeroAddress, 100n),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });
});
