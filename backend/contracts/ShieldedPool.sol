// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";
import {PoseidonT5} from "poseidon-solidity/PoseidonT5.sol";

/// @title ShieldedPool
/// @author Constance Beguier
/// @notice Pool of notes for a single ERC-20 token.
/// @dev A note (pk, value, nonce) is identified by its commitment
///      cm = Poseidon(DS_CMT, pk, value, nonce), where pk = Poseidon(DS_SK, sk) is the
///      owner's public key. Spending a note requires its secret key sk and reveals its
///      nullifier nf = Poseidon(DS_NF, cm, sk). A nullifier can only be revealed once,
///      which prevents spending a note twice.
///      WARNING: for now sk, value and nonce are revealed in the transaction, so anyone
///      who sees them (e.g. in the mempool) can spend all the notes of that key. The ZK
///      proofs will remove this. The Merkle tree will also be added.
///
///      Supported tokens: standard ERC-20 tokens only (e.g. DAI, WETH). Not supported:
///      - fee-on-transfer tokens: rejected by `shield`, which checks the amount received;
///      - tokens that can enable a fee later (e.g. USDT) or whose balances change without
///        a transfer (rebasing tokens such as stETH): the pool could end up holding less
///        than the total value of its notes, and the last notes could not be unshielded;
///      - tokens with transfer hooks (ERC-777).
contract ShieldedPool {
    using SafeERC20 for IERC20;

    /// @notice A note to spend: its owner's public key is derived from the secret key
    /// @param value Value of the note
    /// @param nonce Nonce of the note
    struct InputNote {
        uint256 value;
        uint256 nonce;
    }

    /// @notice A note to create
    /// @param pk Public key of the owner
    /// @param value Value of the note (0 is allowed)
    /// @param nonce Random nonce, makes the commitment unique. It will also make the
    ///              commitment hiding once notes are encrypted: for now `NoteCreated`
    ///              publishes the nonce, so the commitment hides nothing
    struct OutputNote {
        uint256 pk;
        uint256 value;
        uint256 nonce;
    }

    /// @notice Largest allowed note value (2^64 - 1)
    uint256 public constant MAX_VALUE = type(uint64).max;

    /// @notice Order of the BN254 scalar field: keys and nonces must be smaller than this
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Domain separation tag for deriving a public key from a secret key
    uint256 public constant DS_SK = 1;

    /// @notice Domain separation tag for note commitments
    uint256 public constant DS_CMT = 2;

    /// @notice Domain separation tag for nullifiers
    uint256 public constant DS_NF = 3;

    // Upper case as required by solhint for immutables, which Slither flags
    // slither-disable-start naming-convention
    /// @notice The only token accepted by this pool
    IERC20 public immutable TOKEN;
    // slither-disable-end naming-convention

    /// @notice Commitments of all notes ever created (spent or not)
    mapping(uint256 commitment => bool exists) public commitments;

    /// @notice Nullifiers of the notes that have been spent
    mapping(uint256 nullifier => bool revealed) public nullifiers;

    /// @notice Emitted when a note is created
    /// @param commitment Commitment of the new note
    /// @param pk Public key of the owner of the new note
    /// @param value Value of the new note
    /// @param nonce Nonce of the new note
    event NoteCreated(uint256 indexed commitment, uint256 indexed pk, uint256 value, uint256 nonce);

    /// @notice Emitted when a note is spent
    /// @param nullifier Nullifier of the spent note
    event NullifierRevealed(uint256 indexed nullifier);

    /// @notice Emitted when tokens enter the pool
    /// @param from Address the tokens come from
    /// @param pk Public key of the owner of the new note
    /// @param amount Amount of tokens deposited
    event Shielded(address indexed from, uint256 indexed pk, uint256 amount);

    /// @notice Emitted when tokens leave the pool
    /// @param to Address receiving the tokens
    /// @param amount Amount of tokens withdrawn
    event Unshielded(address indexed to, uint256 amount);

    /// @notice The token or receiver address is the zero address
    error ZeroAddress();
    /// @notice The public key is 0 or not smaller than FIELD_SIZE
    error InvalidPublicKey();
    /// @notice The secret key is 0 or not smaller than FIELD_SIZE
    error InvalidSecretKey();
    /// @notice The nonce is not smaller than FIELD_SIZE
    error InvalidNonce();
    /// @notice The value is greater than MAX_VALUE, or 0 for a shield
    error InvalidValue();
    /// @notice No note has this commitment (wrong secret key, value or nonce)
    error UnknownNote();
    /// @notice The note has already been spent: its nullifier was already revealed
    error AlreadySpent();
    /// @notice The same note is used twice as an input
    error DuplicateInput();
    /// @notice A note with this commitment already exists
    error DuplicateCommitment();
    /// @notice The sum of the inputs is not equal to the sum of the outputs
    error UnbalancedTransfer();
    /// @notice The pool did not receive exactly the shielded amount (e.g. fee-on-transfer token)
    error UnsupportedToken();

    /// @notice Creates a pool for `token`
    /// @param token The ERC-20 token accepted by the pool
    constructor(IERC20 token) {
        if (address(token) == address(0)) revert ZeroAddress();
        TOKEN = token;
    }

    /// @notice Deposits `value` tokens and creates a note (pk, value, nonce)
    /// @dev The caller must have approved the pool for `value` tokens
    /// @param pk Public key of the owner of the new note
    /// @param value Amount of tokens to deposit
    /// @param nonce Random nonce of the new note
    /// @return commitment Commitment of the new note
    function shield(
        uint256 pk,
        uint256 value,
        uint256 nonce
    ) external returns (uint256 commitment) {
        // 1. Checks
        if (value == 0) revert InvalidValue();
        commitment = computeCommitment(pk, value, nonce);
        if (commitments[commitment]) revert DuplicateCommitment();

        // 2. State changes
        _createNote(commitment, pk, value, nonce);

        // 3. Transfer, then check that the pool received exactly `value`
        uint256 balanceBefore = TOKEN.balanceOf(address(this));
        TOKEN.safeTransferFrom(msg.sender, address(this), value);
        // Compared with an addition, not a subtraction: if the balance went down,
        // `balanceAfter - balanceBefore` would underflow and revert with Panic(0x11)
        uint256 balanceAfter = TOKEN.balanceOf(address(this));
        if (balanceAfter != balanceBefore + value) revert UnsupportedToken();

        // 4. Emit events
        emit Shielded(msg.sender, pk, value);
    }

    /// @notice Spends two notes owned by the same key and creates two new notes of the
    ///         same total value
    /// @param sk Secret key owning both input notes (revealed, see the contract's warning)
    /// @param inputs The two notes to spend
    /// @param outputs The two notes to create
    /// @return outputCommitments Commitments of the two new notes
    function privateTransfer(
        uint256 sk,
        InputNote[2] calldata inputs,
        OutputNote[2] calldata outputs
    ) external returns (uint256[2] memory outputCommitments) {
        // 1. Checks
        uint256 pk = derivePublicKey(sk);
        uint256[2] memory inputCommitments = [
            computeCommitment(pk, inputs[0].value, inputs[0].nonce),
            computeCommitment(pk, inputs[1].value, inputs[1].nonce)
        ];
        uint256[2] memory inputNullifiers = [
            computeNullifier(inputCommitments[0], sk),
            computeNullifier(inputCommitments[1], sk)
        ];
        if (inputNullifiers[0] == inputNullifiers[1]) revert DuplicateInput();
        _checkSpendable(inputCommitments[0], inputNullifiers[0]);
        _checkSpendable(inputCommitments[1], inputNullifiers[1]);

        for (uint256 i = 0; i < 2; ++i) {
            outputCommitments[i] = computeCommitment(
                outputs[i].pk,
                outputs[i].value,
                outputs[i].nonce
            );
            if (commitments[outputCommitments[i]]) revert DuplicateCommitment();
        }
        if (outputCommitments[0] == outputCommitments[1]) revert DuplicateCommitment();

        // Values are at most 2^64 - 1 (checked by computeCommitment): no overflow
        if (inputs[0].value + inputs[1].value != outputs[0].value + outputs[1].value) {
            revert UnbalancedTransfer();
        }

        // 2. State changes
        for (uint256 i = 0; i < 2; ++i) {
            _revealNullifier(inputNullifiers[i]);
        }
        for (uint256 i = 0; i < 2; ++i) {
            _createNote(outputCommitments[i], outputs[i].pk, outputs[i].value, outputs[i].nonce);
        }
    }

    /// @notice Spends the note (pk(sk), amount, nonce) and sends `amount` tokens to `receiver`
    /// @param sk Secret key owning the note (revealed, see the contract's warning)
    /// @param nonce Nonce of the note
    /// @param receiver Address receiving the tokens
    /// @param amount Value of the note, which is withdrawn entirely
    function unshield(uint256 sk, uint256 nonce, address receiver, uint256 amount) external {
        // 1. Checks
        if (receiver == address(0)) revert ZeroAddress();
        uint256 commitment = computeCommitment(derivePublicKey(sk), amount, nonce);
        uint256 nullifier = computeNullifier(commitment, sk);
        _checkSpendable(commitment, nullifier);

        // 2. State changes
        _revealNullifier(nullifier);

        // 3. Transfer
        TOKEN.safeTransfer(receiver, amount);

        // 4. Emit events
        emit Unshielded(receiver, amount);
    }

    /// @notice Returns the public key of a secret key: pk = Poseidon(DS_SK, sk)
    /// @param sk Secret key, must be non-zero and smaller than FIELD_SIZE
    /// @return The public key
    function derivePublicKey(uint256 sk) public pure returns (uint256) {
        _checkSecretKey(sk);
        return PoseidonT3.hash([DS_SK, sk]);
    }

    /// @notice Returns the nullifier of a note: nf = Poseidon(DS_NF, cm, sk)
    /// @dev Only the owner of the note, who knows sk, can compute it.
    ///      `commitment` is expected to come from `computeCommitment`, which always
    ///      returns a field element.
    /// @param commitment Commitment of the note
    /// @param sk Secret key owning the note, must be non-zero and smaller than FIELD_SIZE
    /// @return The nullifier
    function computeNullifier(uint256 commitment, uint256 sk) public pure returns (uint256) {
        _checkSecretKey(sk);
        return PoseidonT4.hash([DS_NF, commitment, sk]);
    }

    /// @notice Returns the commitment of a note: cm = Poseidon(DS_CMT, pk, value, nonce)
    /// @dev Every field is checked first. Poseidon reduces its inputs modulo FIELD_SIZE,
    ///      so without these checks a note of value v could be spent as a note of value
    ///      v + FIELD_SIZE (same commitment), creating tokens out of nothing.
    /// @param pk Public key of the owner, must be non-zero and smaller than FIELD_SIZE
    /// @param value Value of the note, must be at most MAX_VALUE
    /// @param nonce Nonce of the note, must be smaller than FIELD_SIZE
    /// @return The commitment
    function computeCommitment(
        uint256 pk,
        uint256 value,
        uint256 nonce
    ) public pure returns (uint256) {
        if (pk == 0 || pk > FIELD_SIZE - 1) revert InvalidPublicKey();
        if (value > MAX_VALUE) revert InvalidValue();
        if (nonce > FIELD_SIZE - 1) revert InvalidNonce();
        return PoseidonT5.hash([DS_CMT, pk, value, nonce]);
    }

    /// @notice Reverts unless `sk` is a non-zero field element
    /// @param sk Secret key to check
    function _checkSecretKey(uint256 sk) private pure {
        // 0 is rejected because it is the typical value of an uninitialized key:
        // anyone can compute its public key and spend its notes.
        // Poseidon reduces its inputs modulo FIELD_SIZE: without the upper bound,
        // sk and sk + FIELD_SIZE would give the same public key and nullifiers
        if (sk == 0 || sk > FIELD_SIZE - 1) revert InvalidSecretKey();
    }

    /// @notice Reverts unless the note exists and its nullifier has never been revealed
    /// @param commitment Commitment of the note
    /// @param nullifier Nullifier of the note
    function _checkSpendable(uint256 commitment, uint256 nullifier) private view {
        if (!commitments[commitment]) revert UnknownNote();
        if (nullifiers[nullifier]) revert AlreadySpent();
    }

    /// @notice Stores a new note's commitment
    /// @param commitment Commitment of the note
    /// @param pk Public key of the owner of the note
    /// @param value Value of the note
    /// @param nonce Nonce of the note
    function _createNote(uint256 commitment, uint256 pk, uint256 value, uint256 nonce) private {
        commitments[commitment] = true;
        emit NoteCreated(commitment, pk, value, nonce);
    }

    /// @notice Marks a note as spent by revealing its nullifier
    /// @param nullifier Nullifier of the note
    function _revealNullifier(uint256 nullifier) private {
        nullifiers[nullifier] = true;
        emit NullifierRevealed(nullifier);
    }
}
