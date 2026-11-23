import { expect } from "chai";
import { network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type {
  MockERC20,
  ShieldedPool,
} from "../types/ethers-contracts/index.js";

const { ethers } = await network.create();

const MAX_AMOUNT = 2n ** 64n - 1n;
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Secret keys of Alice and Bob
const ALICE_SK = 111n;
const BOB_SK = 222n;

type Note = { pk: bigint; amount: bigint; nonce: bigint };

// Private inputs of the proofs (in clear for now)
type PrivateTransferProof = {
  sk: bigint;
  inputs: [Note, Note];
  outputs: [Note, Note];
};
type UnshieldProof = { sk: bigint; note: Note };

// Deploys the Poseidon libraries and a pool for `tokenAddress`, linked to them
async function deployPool(tokenAddress: string): Promise<ShieldedPool> {
  const libraries: Record<string, string> = {};
  for (const name of ["PoseidonT3", "PoseidonT4", "PoseidonT5"]) {
    const library = await ethers.deployContract(name);
    libraries[name] = await library.getAddress();
  }
  return ethers.deployContract("ShieldedPool", [tokenAddress], { libraries });
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

  // Commitment and nullifier of `note`, spent with `sk`
  async function commitmentOf(note: Note) {
    return pool.computeCommitment(note.pk, note.amount, note.nonce);
  }
  async function nullifierOf(note: Note, sk: bigint) {
    return pool.computeNullifier(await commitmentOf(note), sk);
  }

  // Spends `inputs` with Alice's secret key (unless `sk` is given) and
  // creates `outputs`. The public inputs (nullifiers and output commitments)
  // are computed from these valid values, as an honest client would. By
  // default the proof uses the same values; a test can send another `proof`
  // to check that the contract rejects it.
  async function transfer(
    inputs: [Note, Note],
    outputs: [Note, Note],
    sk = ALICE_SK,
    proof: PrivateTransferProof = { sk, inputs, outputs },
  ) {
    const inputNullifiers: [bigint, bigint] = [
      await nullifierOf(inputs[0], sk),
      await nullifierOf(inputs[1], sk),
    ];
    const outputCommitments: [bigint, bigint] = [
      await commitmentOf(outputs[0]),
      await commitmentOf(outputs[1]),
    ];
    return pool.privateTransfer(inputNullifiers, outputCommitments, proof);
  }

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

  describe("keys and nullifiers", function () {
    it("Should give different public keys to different secret keys", async function () {
      expect(alicePk).to.not.equal(bobPk);
    });

    it("Should revert if the secret key is 0", async function () {
      await expect(pool.derivePublicKey(0n)).to.be.revertedWithCustomError(
        pool,
        "InvalidSecretKey",
      );
    });

    it("Should revert if the secret key is not smaller than the field size", async function () {
      await expect(
        pool.derivePublicKey(FIELD_SIZE),
      ).to.be.revertedWithCustomError(pool, "InvalidSecretKey");
    });

    it("Should give a nullifier different from the commitment", async function () {
      const note = { pk: alicePk, amount: 100n, nonce: 1n };

      expect(await nullifierOf(note, ALICE_SK)).to.not.equal(
        await commitmentOf(note),
      );
    });

    it("Should give different nullifiers to different notes", async function () {
      expect(
        await nullifierOf({ pk: alicePk, amount: 100n, nonce: 1n }, ALICE_SK),
      ).to.not.equal(
        await nullifierOf({ pk: alicePk, amount: 100n, nonce: 2n }, ALICE_SK),
      );
    });

    it("Should revert if the nullifier's secret key is 0", async function () {
      const commitment = await commitmentOf({
        pk: alicePk,
        amount: 100n,
        nonce: 1n,
      });

      await expect(
        pool.computeNullifier(commitment, 0n),
      ).to.be.revertedWithCustomError(pool, "InvalidSecretKey");
    });

    it("Should revert if the nullifier's secret key is not smaller than the field size", async function () {
      const commitment = await commitmentOf({
        pk: alicePk,
        amount: 100n,
        nonce: 1n,
      });

      await expect(
        pool.computeNullifier(commitment, FIELD_SIZE),
      ).to.be.revertedWithCustomError(pool, "InvalidSecretKey");
    });

    it("Should revert if the commitment is not smaller than the field size", async function () {
      // cm + FIELD_SIZE would give the same nullifier as cm
      const commitment = await commitmentOf({
        pk: alicePk,
        amount: 100n,
        nonce: 1n,
      });

      await expect(
        pool.computeNullifier(commitment + FIELD_SIZE, ALICE_SK),
      ).to.be.revertedWithCustomError(pool, "InvalidCommitment");
    });
  });

  describe("shield", function () {
    it("Should create a note, move the tokens and emit events", async function () {
      const note = { pk: bobPk, amount: 100n, nonce: 1n };
      const commitment = await commitmentOf(note);

      const tx = pool.connect(alice).shield(note);

      await expect(tx)
        .to.emit(pool, "NoteCreated")
        .withArgs(commitment, bobPk, 100n, 1n)
        .and.to.emit(pool, "Shielded")
        .withArgs(alice.address, bobPk, 100n, 1n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [alice, pool],
        [-100n, 100n],
      );

      expect(await pool.commitments(commitment)).to.equal(true);
      expect(await pool.nullifiers(await nullifierOf(note, BOB_SK))).to.equal(
        false,
      );
    });

    it("Should revert if the same note is shielded twice", async function () {
      const note = { pk: alicePk, amount: 100n, nonce: 1n };
      await pool.shield(note);

      await expect(pool.shield(note)).to.be.revertedWithCustomError(
        pool,
        "DuplicateCommitment",
      );
    });

    it("Should revert if the amount is 0", async function () {
      await expect(
        pool.shield({ pk: alicePk, amount: 0n, nonce: 1n }),
      ).to.be.revertedWithCustomError(pool, "InvalidAmount");
    });

    it("Should revert if the amount is greater than 2^64 - 1", async function () {
      await expect(
        pool.shield({ pk: alicePk, amount: MAX_AMOUNT + 1n, nonce: 1n }),
      ).to.be.revertedWithCustomError(pool, "InvalidAmount");
    });

    it("Should revert if the public key is 0", async function () {
      await expect(
        pool.shield({ pk: 0n, amount: 100n, nonce: 1n }),
      ).to.be.revertedWithCustomError(pool, "InvalidPublicKey");
    });

    it("Should revert if the public key is not smaller than the field size", async function () {
      await expect(
        pool.shield({ pk: FIELD_SIZE, amount: 100n, nonce: 1n }),
      ).to.be.revertedWithCustomError(pool, "InvalidPublicKey");
    });

    it("Should revert if the nonce is not smaller than the field size", async function () {
      await expect(
        pool.shield({ pk: alicePk, amount: 100n, nonce: FIELD_SIZE }),
      ).to.be.revertedWithCustomError(pool, "InvalidNonce");
    });

    it("Should revert without enough allowance", async function () {
      // Alice has 2000 tokens but only approved 1000: the allowance is the
      // only thing that is missing
      await token.mint(alice.address, 1000n);

      await expect(
        pool.shield({ pk: alicePk, amount: 1001n, nonce: 1n }),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });

    it("Should reject a fee-on-transfer token", async function () {
      const feeToken = await ethers.deployContract("FeeOnTransferERC20");
      const feePool = await deployPool(await feeToken.getAddress());
      await feeToken.mint(alice.address, 1000n);
      await feeToken.approve(await feePool.getAddress(), 1000n);

      await expect(
        feePool.shield({ pk: alicePk, amount: 100n, nonce: 1n }),
      ).to.be.revertedWithCustomError(feePool, "UnsupportedToken");
    });
  });

  describe("privateTransfer", function () {
    // Alice owns two notes: 60 tokens (nonce 1) and 40 tokens (nonce 2)
    let aliceNotes: [Note, Note];

    beforeEach(async function () {
      aliceNotes = [
        { pk: alicePk, amount: 60n, nonce: 1n },
        { pk: alicePk, amount: 40n, nonce: 2n },
      ];
      for (const note of aliceNotes) {
        await pool.shield(note);
      }
    });

    it("Should spend the inputs, create the outputs and emit events", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 70n, nonce: 3n },
        { pk: alicePk, amount: 30n, nonce: 4n },
      ];
      const inputNullifiers = [
        await nullifierOf(aliceNotes[0], ALICE_SK),
        await nullifierOf(aliceNotes[1], ALICE_SK),
      ];
      const outputCommitments = [
        await commitmentOf(outputs[0]),
        await commitmentOf(outputs[1]),
      ];

      const tx = transfer(aliceNotes, outputs);

      await expect(tx)
        .to.emit(pool, "NullifierRevealed")
        .withArgs(inputNullifiers[0])
        .and.to.emit(pool, "NullifierRevealed")
        .withArgs(inputNullifiers[1])
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

      for (const nullifier of inputNullifiers) {
        expect(await pool.nullifiers(nullifier)).to.equal(true);
      }
      for (const commitment of outputCommitments) {
        expect(await pool.commitments(commitment)).to.equal(true);
      }
      // The new notes are not spent: their nullifiers are not revealed
      expect(
        await pool.nullifiers(await nullifierOf(outputs[0], BOB_SK)),
      ).to.equal(false);
      expect(
        await pool.nullifiers(await nullifierOf(outputs[1], ALICE_SK)),
      ).to.equal(false);
    });

    it("Should allow an output of amount 0", async function () {
      const zero = { pk: alicePk, amount: 0n, nonce: 4n };

      await transfer(aliceNotes, [
        { pk: bobPk, amount: 100n, nonce: 3n },
        zero,
      ]);

      expect(await pool.commitments(await commitmentOf(zero))).to.equal(true);
    });

    it("Should revert if the same note is used twice", async function () {
      await expect(
        transfer(
          [aliceNotes[0], aliceNotes[0]],
          [
            { pk: bobPk, amount: 60n, nonce: 3n },
            { pk: bobPk, amount: 60n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "DuplicateInput");
    });

    it("Should revert with DuplicateInput when the same spent note is used twice", async function () {
      await transfer(aliceNotes, [
        { pk: alicePk, amount: 100n, nonce: 3n },
        { pk: alicePk, amount: 0n, nonce: 4n },
      ]);

      await expect(
        transfer(
          [aliceNotes[0], aliceNotes[0]],
          [
            { pk: bobPk, amount: 120n, nonce: 5n },
            { pk: bobPk, amount: 0n, nonce: 6n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "DuplicateInput");
    });

    it("Should revert if the secret key does not own an input", async function () {
      await expect(
        transfer(
          aliceNotes,
          [
            { pk: bobPk, amount: 100n, nonce: 3n },
            { pk: bobPk, amount: 0n, nonce: 4n },
          ],
          BOB_SK,
        ),
      ).to.be.revertedWithCustomError(pool, "NotOwner");
    });

    it("Should revert if the secret key owns the first input but not the second", async function () {
      const bobNote = { pk: bobPk, amount: 40n, nonce: 5n };
      await pool.connect(bob).shield(bobNote);

      await expect(
        transfer(
          [aliceNotes[0], bobNote],
          [
            { pk: alicePk, amount: 100n, nonce: 3n },
            { pk: alicePk, amount: 0n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "NotOwner");
    });

    it("Should revert if an input does not exist", async function () {
      // Alice has no note of 60 tokens with nonce 99
      await expect(
        transfer(
          [{ pk: alicePk, amount: 60n, nonce: 99n }, aliceNotes[1]],
          [
            { pk: bobPk, amount: 100n, nonce: 3n },
            { pk: bobPk, amount: 0n, nonce: 4n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if an input is already spent", async function () {
      const change = { pk: alicePk, amount: 100n, nonce: 3n };
      await transfer(aliceNotes, [
        change,
        { pk: alicePk, amount: 0n, nonce: 4n },
      ]);

      await expect(
        transfer(
          [aliceNotes[0], change],
          [
            { pk: bobPk, amount: 160n, nonce: 5n },
            { pk: bobPk, amount: 0n, nonce: 6n },
          ],
        ),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should revert if inputs and outputs are not balanced", async function () {
      await expect(
        transfer(aliceNotes, [
          { pk: bobPk, amount: 100n, nonce: 3n },
          { pk: bobPk, amount: 1n, nonce: 4n },
        ]),
      ).to.be.revertedWithCustomError(pool, "UnbalancedTransfer");
    });

    it("Should revert if an input amount is not a valid amount", async function () {
      // 60 + FIELD_SIZE has the same commitment as 60 (Poseidon works modulo
      // FIELD_SIZE): the amount check must reject it. Here it could not create
      // tokens anyway (outputs are at most 2^64 - 1, so the transfer could not
      // balance); the dangerous case is unshield, tested below
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: ALICE_SK,
          inputs: [
            { ...aliceNotes[0], amount: 60n + FIELD_SIZE },
            aliceNotes[1],
          ],
          outputs,
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidAmount");
    });

    it("Should revert if an input nonce is not smaller than the field size", async function () {
      // 1 + FIELD_SIZE has the same commitment as 1 (Poseidon works modulo FIELD_SIZE)
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: ALICE_SK,
          inputs: [{ ...aliceNotes[0], nonce: 1n + FIELD_SIZE }, aliceNotes[1]],
          outputs,
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidNonce");
    });

    it("Should revert if the secret key is not smaller than the field size", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: FIELD_SIZE,
          inputs: aliceNotes,
          outputs,
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidSecretKey");
    });

    it("Should revert if an output amount is greater than 2^64 - 1", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: ALICE_SK,
          inputs: aliceNotes,
          outputs: [{ ...outputs[0], amount: MAX_AMOUNT + 1n }, outputs[1]],
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidAmount");
    });

    it("Should revert if an output public key is 0", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: ALICE_SK,
          inputs: aliceNotes,
          outputs: [{ ...outputs[0], pk: 0n }, outputs[1]],
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidPublicKey");
    });

    it("Should revert if an output public key is not smaller than the field size", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: ALICE_SK,
          inputs: aliceNotes,
          outputs: [{ ...outputs[0], pk: FIELD_SIZE }, outputs[1]],
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidPublicKey");
    });

    it("Should revert if an output nonce is not smaller than the field size", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      await expect(
        transfer(aliceNotes, outputs, ALICE_SK, {
          sk: ALICE_SK,
          inputs: aliceNotes,
          outputs: [{ ...outputs[0], nonce: FIELD_SIZE }, outputs[1]],
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidNonce");
    });

    it("Should revert if a public nullifier does not match the proof", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      const proof = { sk: ALICE_SK, inputs: aliceNotes, outputs };

      await expect(
        pool.privateTransfer(
          [await nullifierOf(aliceNotes[0], ALICE_SK), 123n],
          [await commitmentOf(outputs[0]), await commitmentOf(outputs[1])],
          proof,
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("Should revert if a public output commitment does not match the proof", async function () {
      const outputs: [Note, Note] = [
        { pk: bobPk, amount: 100n, nonce: 3n },
        { pk: bobPk, amount: 0n, nonce: 4n },
      ];
      const proof = { sk: ALICE_SK, inputs: aliceNotes, outputs };

      await expect(
        pool.privateTransfer(
          [
            await nullifierOf(aliceNotes[0], ALICE_SK),
            await nullifierOf(aliceNotes[1], ALICE_SK),
          ],
          [await commitmentOf(outputs[0]), 123n],
          proof,
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("Should revert if the two outputs are the same note", async function () {
      const output = { pk: bobPk, amount: 50n, nonce: 3n };

      await expect(
        transfer(aliceNotes, [output, output]),
      ).to.be.revertedWithCustomError(pool, "DuplicateCommitment");
    });

    it("Should revert if an output is one of the inputs", async function () {
      // The output is a note being spent: its commitment already exists
      await expect(
        transfer(aliceNotes, [
          aliceNotes[0],
          { pk: alicePk, amount: 40n, nonce: 3n },
        ]),
      ).to.be.revertedWithCustomError(pool, "DuplicateCommitment");
    });

    it("Should revert if an output is a note spent in an earlier transaction", async function () {
      // Spends Alice's two notes, creating notes of 100 and 0
      const change: [Note, Note] = [
        { pk: alicePk, amount: 100n, nonce: 3n },
        { pk: alicePk, amount: 0n, nonce: 4n },
      ];
      await transfer(aliceNotes, change);

      // aliceNotes[0] is spent, but its commitment still exists: it can never
      // be created again
      await expect(
        transfer(change, [
          aliceNotes[0],
          { pk: alicePk, amount: 40n, nonce: 5n },
        ]),
      ).to.be.revertedWithCustomError(pool, "DuplicateCommitment");
    });
  });

  describe("unshield", function () {
    // Alice owns a note of 100 tokens (nonce 1)
    let aliceNote: Note;

    beforeEach(async function () {
      aliceNote = { pk: alicePk, amount: 100n, nonce: 1n };
      await pool.shield(aliceNote);
    });

    // Spends `note` with Alice's secret key (unless `sk` is given) and sends
    // its amount to `receiver`. The public inputs (nullifier and amount) are
    // computed from these valid values, as an honest client would. By default
    // the proof uses the same values; a test can send another `proof` to check
    // that the contract rejects it.
    async function unshield(
      note: Note,
      receiver: string,
      sk = ALICE_SK,
      proof: UnshieldProof = { sk, note },
    ) {
      return pool.unshield(
        await nullifierOf(note, sk),
        receiver,
        note.amount,
        proof,
      );
    }

    it("Should send the note's amount to the receiver and emit events", async function () {
      const nullifier = await nullifierOf(aliceNote, ALICE_SK);

      const tx = unshield(aliceNote, carol.address);

      await expect(tx)
        .to.emit(pool, "NullifierRevealed")
        .withArgs(nullifier)
        .and.to.emit(pool, "Unshielded")
        .withArgs(carol.address, 100n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [pool, carol],
        [-100n, 100n],
      );

      expect(await pool.nullifiers(nullifier)).to.equal(true);
    });

    it("Should let anyone who knows the secret key spend the note", async function () {
      // The secret key is public for now: Bob can steal Alice's note
      await expect(
        pool
          .connect(bob)
          .unshield(await nullifierOf(aliceNote, ALICE_SK), bob.address, 100n, {
            sk: ALICE_SK,
            note: aliceNote,
          }),
      ).to.changeTokenBalances(ethers, token, [pool, bob], [-100n, 100n]);
    });

    it("Should revert when unshielding the same note twice", async function () {
      await unshield(aliceNote, alice.address);

      await expect(
        unshield(aliceNote, alice.address),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should revert when unshielding a note already spent by a transfer", async function () {
      const other = { pk: alicePk, amount: 50n, nonce: 2n };
      await pool.shield(other);
      await transfer(
        [aliceNote, other],
        [
          { pk: bobPk, amount: 150n, nonce: 3n },
          { pk: alicePk, amount: 0n, nonce: 4n },
        ],
      );

      await expect(
        unshield(aliceNote, alice.address),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should unshield a note of amount 0", async function () {
      // Alice shields a second note, then turns both into 150 + 0
      const other = { pk: alicePk, amount: 50n, nonce: 2n };
      const zero = { pk: alicePk, amount: 0n, nonce: 4n };
      await pool.shield(other);
      await transfer(
        [aliceNote, other],
        [{ pk: alicePk, amount: 150n, nonce: 3n }, zero],
      );

      const tx = unshield(zero, carol.address);

      await expect(tx).to.emit(pool, "Unshielded").withArgs(carol.address, 0n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [pool, carol],
        [0n, 0n],
      );
    });

    it("Should revert if the secret key does not own the note", async function () {
      await expect(
        unshield(aliceNote, bob.address, BOB_SK),
      ).to.be.revertedWithCustomError(pool, "NotOwner");
    });

    it("Should revert if the public amount is not the note's amount", async function () {
      await expect(
        pool.unshield(
          await nullifierOf(aliceNote, ALICE_SK),
          alice.address,
          50n,
          { sk: ALICE_SK, note: aliceNote },
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("Should revert if the public nullifier does not match the proof", async function () {
      await expect(
        pool.unshield(123n, alice.address, 100n, {
          sk: ALICE_SK,
          note: aliceNote,
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("Should revert if the note does not exist", async function () {
      // Alice has no note of 100 tokens with nonce 99
      await expect(
        unshield({ ...aliceNote, nonce: 99n }, alice.address),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if the secret key is not smaller than the field size", async function () {
      await expect(
        unshield(aliceNote, alice.address, ALICE_SK, {
          sk: FIELD_SIZE,
          note: aliceNote,
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidSecretKey");
    });

    it("Should revert if the nonce is not smaller than the field size", async function () {
      // 1 + FIELD_SIZE has the same commitment as 1 (Poseidon works modulo FIELD_SIZE)
      await expect(
        unshield(aliceNote, alice.address, ALICE_SK, {
          sk: ALICE_SK,
          note: { ...aliceNote, nonce: 1n + FIELD_SIZE },
        }),
      ).to.be.revertedWithCustomError(pool, "InvalidNonce");
    });

    it("Should revert if the amount is greater than 2^64 - 1", async function () {
      // 100 + FIELD_SIZE has the same commitment as 100: without the amount
      // check, the pool would send 100 + FIELD_SIZE tokens
      await expect(
        pool.unshield(
          await nullifierOf(aliceNote, ALICE_SK),
          alice.address,
          100n + FIELD_SIZE,
          { sk: ALICE_SK, note: { ...aliceNote, amount: 100n + FIELD_SIZE } },
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidAmount");
    });

    it("Should revert if the receiver is the zero address", async function () {
      await expect(
        unshield(aliceNote, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });
});
