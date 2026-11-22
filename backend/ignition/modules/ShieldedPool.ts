import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys a test token (MockERC20) and a ShieldedPool for it.
// Used both locally and on Sepolia: anyone can mint MockERC20 tokens,
// which makes it easy to try the pool.
export default buildModule("ShieldedPoolModule", (m) => {
  const token = m.contract("MockERC20");

  // PoseidonT3 is an external library: it is deployed on its own, then
  // linked to ShieldedPool
  const poseidonT3 = m.library("PoseidonT3");

  const pool = m.contract("ShieldedPool", [token], {
    libraries: { PoseidonT3: poseidonT3 },
  });

  return { token, pool };
});
