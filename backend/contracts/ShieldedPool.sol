// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

/// @title ShieldedPool
/// @author Constance Beguier
/// @notice Pool of notes for a single ERC-20 token.
/// @dev Everything is still stored in clear. A note is owned by a public key
///      pk = Poseidon(DS_SK, sk), and spending it requires the secret key sk.
///      WARNING: for now sk is revealed in the transaction, so anyone who sees it
///      (e.g. in the mempool) can spend all the notes of that key. The ZK proofs will
///      remove this. Commitments, nullifiers and the Merkle tree will also be added.
///
///      Supported tokens: standard ERC-20 tokens only (e.g. DAI, WETH). Not supported:
///      - fee-on-transfer tokens: rejected by `shield`, which checks the amount received;
///      - tokens that can enable a fee later (e.g. USDT) or whose balances change without
///        a transfer (rebasing tokens such as stETH): the pool could end up holding less
///        than the total value of its notes, and the last notes could not be unshielded;
///      - tokens with transfer hooks (ERC-777).
contract ShieldedPool {
    using SafeERC20 for IERC20;

    /// @notice A note: an amount of tokens owned by a public key
    /// @param pk Public key of the owner, pk = Poseidon(DS_SK, sk)
    /// @param spent True once the note has been spent
    /// @param value Amount of tokens, in the token's smallest unit
    struct Note {
        uint256 pk;
        bool spent;
        uint256 value;
    }

    /// @notice Largest allowed note value (2^64 - 1)
    uint256 public constant MAX_VALUE = type(uint64).max;

    /// @notice Order of the BN254 scalar field: keys must be smaller than this
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Domain separation tag for deriving a public key from a secret key
    uint256 public constant DS_SK = 1;

    // Upper case as required by solhint for immutables, which Slither flags
    // slither-disable-start naming-convention
    /// @notice The only token accepted by this pool
    IERC20 public immutable TOKEN;
    // slither-disable-end naming-convention

    /// @notice All notes ever created, by id
    mapping(uint256 id => Note note) public notes;

    /// @notice Id of the next note to be created
    uint256 public nextNoteId;

    /// @notice Emitted when a note is created
    /// @param id Id of the new note
    /// @param pk Public key of the owner of the new note
    /// @param value Value of the new note
    event NoteCreated(uint256 indexed id, uint256 indexed pk, uint256 value);

    /// @notice Emitted when a note is spent
    /// @param id Id of the spent note
    event NoteSpent(uint256 indexed id);

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
    /// @notice The secret key is not smaller than FIELD_SIZE
    error InvalidSecretKey();
    /// @notice The value is 0 or greater than MAX_VALUE
    error InvalidValue();
    /// @notice The note does not exist
    error UnknownNote();
    /// @notice The secret key does not match the note's public key
    error NotOwner();
    /// @notice The note has already been spent
    error AlreadySpent();
    /// @notice The same note is used twice as an input
    error DuplicateInput();
    /// @notice The sum of the inputs is not equal to the sum of the outputs
    error UnbalancedTransfer();
    /// @notice The requested amount is not equal to the note's value
    error AmountMismatch();
    /// @notice The pool did not receive exactly the shielded amount (e.g. fee-on-transfer token)
    error UnsupportedToken();

    /// @notice Creates a pool for `token`
    /// @param token The ERC-20 token accepted by the pool
    constructor(IERC20 token) {
        if (address(token) == address(0)) revert ZeroAddress();
        TOKEN = token;
    }

    /// @notice Deposits `value` tokens and creates a note owned by the public key `pk`
    /// @dev The caller must have approved the pool for `value` tokens
    /// @param pk Public key of the owner of the new note
    /// @param value Amount of tokens to deposit
    /// @return id Id of the new note
    function shield(uint256 pk, uint256 value) external returns (uint256 id) {
        // 1. Checks
        _checkPublicKey(pk);
        if (value == 0 || value > MAX_VALUE) revert InvalidValue();

        // 2. State changes
        id = _createNote(pk, value);

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
    /// @param inputIds Ids of the two notes to spend
    /// @param sk Secret key owning both input notes (revealed, see the contract's warning)
    /// @param outputPks Public keys of the owners of the two new notes
    /// @param outputValues Values of the two new notes (0 is allowed)
    /// @return outputIds Ids of the two new notes
    function privateTransfer(
        uint256[2] calldata inputIds,
        uint256 sk,
        uint256[2] calldata outputPks,
        uint256[2] calldata outputValues
    ) external returns (uint256[2] memory outputIds) {
        // 1. Checks
        if (inputIds[0] == inputIds[1]) revert DuplicateInput();
        uint256 pk = derivePublicKey(sk);
        uint256 inputTotal = _checkSpendable(inputIds[0], pk) + _checkSpendable(inputIds[1], pk);

        for (uint256 i = 0; i < 2; ++i) {
            _checkPublicKey(outputPks[i]);
            if (outputValues[i] > MAX_VALUE) revert InvalidValue();
        }
        if (inputTotal != outputValues[0] + outputValues[1]) revert UnbalancedTransfer();

        // 2. State changes
        _spendNote(inputIds[0]);
        _spendNote(inputIds[1]);
        outputIds[0] = _createNote(outputPks[0], outputValues[0]);
        outputIds[1] = _createNote(outputPks[1], outputValues[1]);
    }

    /// @notice Spends a note and sends its value to `receiver`
    /// @param id Id of the note to spend
    /// @param sk Secret key owning the note (revealed, see the contract's warning)
    /// @param receiver Address receiving the tokens
    /// @param amount Amount to withdraw, must be equal to the note's value
    function unshield(uint256 id, uint256 sk, address receiver, uint256 amount) external {
        // 1. Checks
        if (receiver == address(0)) revert ZeroAddress();
        if (_checkSpendable(id, derivePublicKey(sk)) != amount) revert AmountMismatch();

        // 2. State changes
        _spendNote(id);

        // 3. Transfer
        TOKEN.safeTransfer(receiver, amount);

        // 4. Emit events
        emit Unshielded(receiver, amount);
    }

    /// @notice Returns the public key of a secret key: pk = Poseidon(DS_SK, sk)
    /// @param sk Secret key, must be smaller than FIELD_SIZE
    /// @return The public key
    function derivePublicKey(uint256 sk) public pure returns (uint256) {
        // PoseidonT3 reduces its inputs modulo FIELD_SIZE: without this check,
        // sk and sk + FIELD_SIZE would give the same public key
        if (sk > FIELD_SIZE - 1) revert InvalidSecretKey();
        return PoseidonT3.hash([DS_SK, sk]);
    }

    /// @notice Reverts unless `pk` is a non-zero field element
    /// @dev 0 is reserved: it marks notes that do not exist
    /// @param pk Public key to check
    function _checkPublicKey(uint256 pk) private pure {
        if (pk == 0 || pk > FIELD_SIZE - 1) revert InvalidPublicKey();
    }

    /// @notice Reverts unless note `id` exists, is owned by `pk` and is unspent
    /// @param id Id of the note
    /// @param pk Public key derived from the secret key given by the caller
    /// @return value Value of the note
    function _checkSpendable(uint256 id, uint256 pk) private view returns (uint256 value) {
        Note storage note = notes[id];
        // Every existing note has a non-zero public key
        if (note.pk == 0) revert UnknownNote();
        if (note.pk != pk) revert NotOwner();
        if (note.spent) revert AlreadySpent();
        return note.value;
    }

    /// @notice Creates a note and returns its id
    /// @param pk Public key of the owner of the note
    /// @param value Value of the note
    /// @return id Id of the new note
    function _createNote(uint256 pk, uint256 value) private returns (uint256 id) {
        id = nextNoteId;
        ++nextNoteId;
        notes[id] = Note({pk: pk, spent: false, value: value});
        emit NoteCreated(id, pk, value);
    }

    /// @notice Marks note `id` as spent
    /// @param id Id of the note
    function _spendNote(uint256 id) private {
        notes[id].spent = true;
        emit NoteSpent(id);
    }
}
