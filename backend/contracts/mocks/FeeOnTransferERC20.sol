// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {MockERC20} from "./MockERC20.sol";

/// @title FeeOnTransferERC20
/// @author Constance Beguier
/// @notice Test-only token that burns 1% of every transfer, to check that the pool rejects it
contract FeeOnTransferERC20 is MockERC20 {
    /// @notice Moves tokens, burning 1% of the amount when it is a transfer (not a mint or burn)
    /// @param from Sender
    /// @param to Receiver
    /// @param value Amount sent by `from`
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 100;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
