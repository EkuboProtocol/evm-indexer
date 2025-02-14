import { CORE_ABI, CORE_V2_ABI, POSITIONS_ABI } from "./abis";
import type { ContractEvent } from "./logProcessors.ts";

export type PoolKey =
  | ContractEvent<typeof CORE_ABI, "PoolInitialized">["poolKey"]
  | ContractEvent<typeof CORE_V2_ABI, "PoolInitialized">["poolKey"];

export type CorePositionUpdated =
  | ContractEvent<typeof CORE_V2_ABI, "PositionUpdated">
  | ContractEvent<typeof CORE_ABI, "PositionUpdated">;
export type CorePoolInitialized =
  | ContractEvent<typeof CORE_V2_ABI, "PoolInitialized">
  | ContractEvent<typeof CORE_ABI, "PoolInitialized">;
export type CorePositionFeesCollected =
  | ContractEvent<typeof CORE_V2_ABI, "PositionFeesCollected">
  | ContractEvent<typeof CORE_ABI, "PositionFeesCollected">;
export type CoreProtocolFeesWithdrawn =
  | ContractEvent<typeof CORE_V2_ABI, "ProtocolFeesWithdrawn">
  | ContractEvent<typeof CORE_ABI, "ProtocolFeesWithdrawn">;
export type CoreExtensionRegistered =
  | ContractEvent<typeof CORE_V2_ABI, "ExtensionRegistered">
  | ContractEvent<typeof CORE_ABI, "ExtensionRegistered">;
export type CoreFeesAccumulated =
  | ContractEvent<typeof CORE_V2_ABI, "FeesAccumulated">
  | ContractEvent<typeof CORE_ABI, "FeesAccumulated">;

export type PositionTransfer = ContractEvent<typeof POSITIONS_ABI, "Transfer">;
