// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ShieldedPool
/// @author Constance Beguier
/// @notice Pool of notes for a single ERC-20 token.
/// @dev Step 1: everything is stored in clear and notes are owned by Ethereum addresses.
///      Commitments, nullifiers, the Merkle tree and the ZK proofs will replace these
///      pieces one by one.
contract ShieldedPool {
    using SafeERC20 for IERC20;

    /// @notice A note: an amount of tokens owned by someone
    /// @param owner Address allowed to spend the note
    /// @param spent True once the note has been spent
    /// @param value Amount of tokens, in the token's smallest unit
    struct Note {
        address owner;
        bool spent;
        uint256 value;
    }

    /// @notice Largest allowed note value (2^64 - 1)
    uint256 public constant MAX_VALUE = type(uint64).max;

    /// @notice The only token accepted by this pool
    IERC20 public immutable TOKEN;

    /// @notice All notes ever created, by id
    mapping(uint256 id => Note note) public notes;

    /// @notice Id of the next note to be created
    uint256 public nextNoteId;

    /// @notice Emitted when a note is created
    /// @param id Id of the new note
    /// @param owner Owner of the new note
    /// @param value Value of the new note
    event NoteCreated(uint256 indexed id, address indexed owner, uint256 value);

    /// @notice Emitted when a note is spent
    /// @param id Id of the spent note
    event NoteSpent(uint256 indexed id);

    /// @notice Emitted when tokens enter the pool
    /// @param from Address the tokens come from
    /// @param owner Owner of the new note
    /// @param amount Amount of tokens deposited
    event Shielded(address indexed from, address indexed owner, uint256 amount);

    /// @notice Emitted when tokens leave the pool
    /// @param to Address receiving the tokens
    /// @param amount Amount of tokens withdrawn
    event Unshielded(address indexed to, uint256 amount);

    /// @notice The token address is the zero address
    error ZeroAddress();
    /// @notice The value is 0 or greater than MAX_VALUE
    error InvalidValue();
    /// @notice The note does not exist
    error UnknownNote();
    /// @notice The caller does not own the note
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

    /// @notice Deposits `value` tokens and creates a note owned by `owner`
    /// @dev The caller must have approved the pool for `value` tokens
    /// @param owner Owner of the new note
    /// @param value Amount of tokens to deposit
    /// @return id Id of the new note
    function shield(address owner, uint256 value) external returns (uint256 id) {
        // 1. Checks
        if (owner == address(0)) revert ZeroAddress();
        if (value == 0 || value > MAX_VALUE) revert InvalidValue();

        // 2. State changes
        id = _createNote(owner, value);

        // 3. Transfer, then check that the pool received exactly `value`
        uint256 balanceBefore = TOKEN.balanceOf(address(this));
        TOKEN.safeTransferFrom(msg.sender, address(this), value);
        if (TOKEN.balanceOf(address(this)) - balanceBefore != value) revert UnsupportedToken();

        // 4. Emit events
        emit Shielded(msg.sender, owner, value);
    }

    /// @notice Spends two notes of the caller and creates two new notes of the same total value
    /// @param inputIds Ids of the two notes to spend
    /// @param outputOwners Owners of the two new notes
    /// @param outputValues Values of the two new notes (0 is allowed)
    /// @return outputIds Ids of the two new notes
    function privateTransfer(
        uint256[2] calldata inputIds,
        address[2] calldata outputOwners,
        uint256[2] calldata outputValues
    ) external returns (uint256[2] memory outputIds) {
        // 1. Checks
        if (inputIds[0] == inputIds[1]) revert DuplicateInput();
        uint256 inputTotal = _checkSpendable(inputIds[0]) + _checkSpendable(inputIds[1]);

        for (uint256 i = 0; i < 2; ++i) {
            if (outputOwners[i] == address(0)) revert ZeroAddress();
            if (outputValues[i] > MAX_VALUE) revert InvalidValue();
        }
        if (inputTotal != outputValues[0] + outputValues[1]) revert UnbalancedTransfer();

        // 2. State changes
        _spendNote(inputIds[0]);
        _spendNote(inputIds[1]);
        outputIds[0] = _createNote(outputOwners[0], outputValues[0]);
        outputIds[1] = _createNote(outputOwners[1], outputValues[1]);
    }

    /// @notice Spends a note of the caller and sends its value to `receiver`
    /// @param id Id of the note to spend
    /// @param receiver Address receiving the tokens
    /// @param amount Amount to withdraw, must be equal to the note's value
    function unshield(uint256 id, address receiver, uint256 amount) external {
        // 1. Checks
        if (receiver == address(0)) revert ZeroAddress();
        if (_checkSpendable(id) != amount) revert AmountMismatch();

        // 2. State changes
        _spendNote(id);

        // 3. Transfer
        TOKEN.safeTransfer(receiver, amount);

        // 4. Emit events
        emit Unshielded(receiver, amount);
    }

    /// @notice Reverts unless note `id` exists, is owned by the caller and is unspent
    /// @param id Id of the note
    /// @return value Value of the note
    function _checkSpendable(uint256 id) private view returns (uint256 value) {
        Note storage note = notes[id];
        // Every existing note has a non-zero owner
        if (note.owner == address(0)) revert UnknownNote();
        if (note.owner != msg.sender) revert NotOwner();
        if (note.spent) revert AlreadySpent();
        return note.value;
    }

    /// @notice Creates a note and returns its id
    /// @param owner Owner of the note
    /// @param value Value of the note
    /// @return id Id of the new note
    function _createNote(address owner, uint256 value) private returns (uint256 id) {
        id = nextNoteId;
        ++nextNoteId;
        notes[id] = Note({owner: owner, spent: false, value: value});
        emit NoteCreated(id, owner, value);
    }

    /// @notice Marks note `id` as spent
    /// @param id Id of the note
    function _spendNote(uint256 id) private {
        notes[id].spent = true;
        emit NoteSpent(id);
    }
}
