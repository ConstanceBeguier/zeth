// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @author Constance Beguier
/// @notice Test-only ERC-20 token that anyone can mint
contract MockERC20 is ERC20 {
    /// @notice Creates the token
    constructor() ERC20("Mock Token", "MOCK") {}

    /// @notice Mints `amount` tokens to `to`
    /// @param to Receiver of the tokens
    /// @param amount Amount of tokens to mint
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
