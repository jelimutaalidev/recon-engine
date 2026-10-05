// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

type Balance is uint256;
enum FileState {
    Open,
    Closed
}

interface ITarget {
    function ping() external returns (bool);
}

contract Unsupported is ITarget {
    struct Info {
        uint256 amount;
        address who;
    }

    enum LocalState {
        Idle,
        Active
    }

    uint256 acc;

    function mix(uint256 x, address caller) external returns (uint256) {
        Info memory info = Info(x, caller);
        LocalState state = LocalState.Idle;
        if (info.amount > 0) {
            acc = info.amount;
        }
        uint256 y = x + (msg.sender == caller ? 1 : 0);
        assembly {
            y := add(y, 1)
        }
        try this.ping() returns (bool ok) {
            if (ok) y += 1;
        } catch {
            y += 2;
        }
        return y + acc + uint256(uint8(state)) + uint256(uint8(FileState.Open));
    }

    function ping() external returns (bool) {
        return acc > 0;
    }
}
