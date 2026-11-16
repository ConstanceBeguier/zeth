// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

/// @title Counter
/// @author Zeth contributors
/// @notice Minimal counter used as a template contract
contract Counter {
    /// @notice Current value of the counter
    uint256 public x;

    /// @notice Emitted each time the counter is incremented
    /// @param by Amount the counter was incremented by
    event Increment(uint256 indexed by);

    /// @notice Thrown when `incBy` is called with a zero increment
    error ZeroIncrement();

    /// @notice Increments the counter by one
    function inc() external {
        ++x;
        emit Increment(1);
    }

    /// @notice Increments the counter by `by`
    /// @param by Amount to add, must be strictly positive
    function incBy(uint256 by) external {
        if (by == 0) revert ZeroIncrement();
        x += by;
        emit Increment(by);
    }
}
