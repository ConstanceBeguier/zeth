import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys a test token (MockERC20) and a ShieldedPool for it.
// Used both locally and on Sepolia: anyone can mint MockERC20 tokens,
// which makes it easy to try the pool.
export default buildModule("ShieldedPoolModule", (m) => {
  const token = m.contract("MockERC20");

  const pool = m.contract("ShieldedPool", [token]);

  return { token, pool };
});
