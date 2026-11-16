// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {Counter} from "./Counter.sol";
import {Test} from "forge-std/Test.sol";

// Solidity tests are compatible with foundry, so they
// use the same syntax and offer the same functionality.

contract CounterTest is Test {
    Counter internal counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_InitialValue() public view {
        assertEq(counter.x(), 0);
    }

    function testFuzz_Inc(uint8 x) public {
        for (uint8 i = 0; i < x; ++i) {
            counter.inc();
        }
        assertEq(counter.x(), x);
    }

    function test_IncBy(uint256 by) public {
        by = bound(by, 1, type(uint128).max);
        vm.expectEmit(true, false, false, false, address(counter));
        emit Counter.Increment(by);
        counter.incBy(by);
        assertEq(counter.x(), by);
    }

    function test_IncByZero() public {
        vm.expectRevert(Counter.ZeroIncrement.selector);
        counter.incBy(0);
    }
}
