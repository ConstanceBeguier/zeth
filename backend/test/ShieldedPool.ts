import { expect } from "chai";
import { network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type {
  MockERC20,
  ShieldedPool,
} from "../types/ethers-contracts/index.js";

const { ethers } = await network.create();

const MAX_VALUE = 2n ** 64n - 1n;

describe("ShieldedPool", function () {
  let token: MockERC20;
  let pool: ShieldedPool;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  // Before every test: a fresh token and pool, and 1000 tokens for Alice and
  // Bob, both of whom approve the pool
  beforeEach(async function () {
    [alice, bob, carol] = await ethers.getSigners();

    token = await ethers.deployContract("MockERC20");
    pool = await ethers.deployContract("ShieldedPool", [
      await token.getAddress(),
    ]);

    for (const user of [alice, bob]) {
      await token.mint(user.address, 1000n);
      await token.connect(user).approve(await pool.getAddress(), 1000n);
    }
  });

  describe("deployment", function () {
    it("Should store the token address", async function () {
      expect(await pool.TOKEN()).to.equal(await token.getAddress());
    });

    it("Should revert if the token is the zero address", async function () {
      await expect(
        ethers.deployContract("ShieldedPool", [ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("shield", function () {
    it("Should create a note, move the tokens and emit events", async function () {
      const tx = pool.connect(alice).shield(bob.address, 100n);

      await expect(tx)
        .to.emit(pool, "NoteCreated")
        .withArgs(0n, bob.address, 100n)
        .and.to.emit(pool, "Shielded")
        .withArgs(alice.address, bob.address, 100n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [alice, pool],
        [-100n, 100n],
      );

      const note = await pool.notes(0n);
      expect(note.owner).to.equal(bob.address);
      expect(note.value).to.equal(100n);
      expect(note.spent).to.equal(false);
      expect(await pool.nextNoteId()).to.equal(1n);
    });

    it("Should revert if the value is 0", async function () {
      await expect(
        pool.shield(alice.address, 0n),
      ).to.be.revertedWithCustomError(pool, "InvalidValue");
    });

    it("Should revert if the value is greater than 2^64 - 1", async function () {
      await expect(
        pool.shield(alice.address, MAX_VALUE + 1n),
      ).to.be.revertedWithCustomError(pool, "InvalidValue");
    });

    it("Should revert if the owner is the zero address", async function () {
      await expect(
        pool.shield(ethers.ZeroAddress, 100n),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("Should revert without enough allowance", async function () {
      await expect(pool.shield(alice.address, 1001n)).to.revert(ethers);
    });

    it("Should reject a fee-on-transfer token", async function () {
      const feeToken = await ethers.deployContract("FeeOnTransferERC20");
      const feePool = await ethers.deployContract("ShieldedPool", [
        await feeToken.getAddress(),
      ]);
      await feeToken.mint(alice.address, 1000n);
      await feeToken.approve(await feePool.getAddress(), 1000n);

      await expect(
        feePool.shield(alice.address, 100n),
      ).to.be.revertedWithCustomError(feePool, "UnsupportedToken");
    });
  });

  describe("privateTransfer", function () {
    // Alice owns note 0 (60 tokens) and note 1 (40 tokens)
    beforeEach(async function () {
      await pool.connect(alice).shield(alice.address, 60n);
      await pool.connect(alice).shield(alice.address, 40n);
    });

    // Alice spends `inputs` and creates two notes for `owners` with `values`
    function transfer(
      inputs: [bigint, bigint],
      owners: [string, string],
      values: [bigint, bigint],
    ) {
      return pool.connect(alice).privateTransfer(inputs, owners, values);
    }

    it("Should spend the inputs, create the outputs and emit events", async function () {
      const tx = transfer([0n, 1n], [bob.address, alice.address], [70n, 30n]);

      await expect(tx)
        .to.emit(pool, "NoteSpent")
        .withArgs(0n)
        .and.to.emit(pool, "NoteSpent")
        .withArgs(1n)
        .and.to.emit(pool, "NoteCreated")
        .withArgs(2n, bob.address, 70n)
        .and.to.emit(pool, "NoteCreated")
        .withArgs(3n, alice.address, 30n);
      // A private transfer never moves tokens
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [alice, bob, pool],
        [0n, 0n, 0n],
      );

      expect((await pool.notes(0n)).spent).to.equal(true);
      expect((await pool.notes(1n)).spent).to.equal(true);
      expect((await pool.notes(2n)).owner).to.equal(bob.address);
      expect((await pool.notes(2n)).value).to.equal(70n);
      expect((await pool.notes(3n)).owner).to.equal(alice.address);
      expect((await pool.notes(3n)).value).to.equal(30n);
    });

    it("Should allow an output of value 0", async function () {
      await transfer([0n, 1n], [bob.address, alice.address], [100n, 0n]);

      expect((await pool.notes(3n)).value).to.equal(0n);
    });

    it("Should revert if the same note is used twice", async function () {
      await expect(
        transfer([0n, 0n], [bob.address, bob.address], [60n, 60n]),
      ).to.be.revertedWithCustomError(pool, "DuplicateInput");
    });

    it("Should revert if the caller does not own an input", async function () {
      await pool.connect(bob).shield(bob.address, 10n); // note 2, owned by Bob

      await expect(
        transfer([0n, 2n], [alice.address, alice.address], [70n, 0n]),
      ).to.be.revertedWithCustomError(pool, "NotOwner");
    });

    it("Should revert if an input does not exist", async function () {
      await expect(
        transfer([0n, 42n], [alice.address, alice.address], [60n, 0n]),
      ).to.be.revertedWithCustomError(pool, "UnknownNote");
    });

    it("Should revert if an input is already spent", async function () {
      // Spends notes 0 and 1, creates notes 2 (100) and 3 (0)
      await transfer([0n, 1n], [alice.address, alice.address], [100n, 0n]);

      await expect(
        transfer([0n, 2n], [alice.address, alice.address], [160n, 0n]),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should revert if inputs and outputs are not balanced", async function () {
      await expect(
        transfer([0n, 1n], [alice.address, alice.address], [100n, 1n]),
      ).to.be.revertedWithCustomError(pool, "UnbalancedTransfer");
    });

    it("Should revert if an output value is greater than 2^64 - 1", async function () {
      await expect(
        transfer(
          [0n, 1n],
          [alice.address, alice.address],
          [MAX_VALUE + 1n, 0n],
        ),
      ).to.be.revertedWithCustomError(pool, "InvalidValue");
    });

    it("Should revert if an output owner is the zero address", async function () {
      await expect(
        transfer([0n, 1n], [ethers.ZeroAddress, alice.address], [100n, 0n]),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("unshield", function () {
    // Alice owns note 0 (100 tokens)
    beforeEach(async function () {
      await pool.connect(alice).shield(alice.address, 100n);
    });

    it("Should send the note's value to the receiver and emit events", async function () {
      const tx = pool.connect(alice).unshield(0n, carol.address, 100n);

      await expect(tx)
        .to.emit(pool, "NoteSpent")
        .withArgs(0n)
        .and.to.emit(pool, "Unshielded")
        .withArgs(carol.address, 100n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        token,
        [pool, carol],
        [-100n, 100n],
      );

      expect((await pool.notes(0n)).spent).to.equal(true);
    });

    it("Should revert when unshielding the same note twice", async function () {
      await pool.connect(alice).unshield(0n, alice.address, 100n);

      await expect(
        pool.connect(alice).unshield(0n, alice.address, 100n),
      ).to.be.revertedWithCustomError(pool, "AlreadySpent");
    });

    it("Should revert if the caller does not own the note", async function () {
      await expect(
        pool.connect(bob).unshield(0n, bob.address, 100n),
      ).to.be.revertedWithCustomError(pool, "NotOwner");
    });

    it("Should revert if the amount is not the note's value", async function () {
      await expect(
        pool.connect(alice).unshield(0n, alice.address, 50n),
      ).to.be.revertedWithCustomError(pool, "AmountMismatch");
    });

    it("Should revert if the receiver is the zero address", async function () {
      await expect(
        pool.connect(alice).unshield(0n, ethers.ZeroAddress, 100n),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });
});
