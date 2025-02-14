import { checksumAddress, numberToHex } from "viem";

export function toSigned(value: bigint, bits: number): bigint {
  const half = 1n << BigInt(bits - 1);
  return value >= half ? value - (1n << BigInt(bits)) : value;
}

export interface CoreSwapped {
  locker: `0x${string}`;
  poolId: `0x${string}`;
  delta0: bigint;
  delta1: bigint;
  liquidityAfter: bigint;
  sqrtRatioAfter: bigint;
  tickAfter: number;
}

const BIT_MASK = 0xc00000000000000000000000n;
const NOT_BIT_MASK = 0x3fffffffffffffffffffffffn;
function toFixed(sqrtRatioFloat: bigint): bigint {
  return (
    (sqrtRatioFloat & NOT_BIT_MASK) <<
    (2n + ((sqrtRatioFloat & BIT_MASK) >> 89n))
  );
}

export function parseV2SwapEventData(data: `0x${string}`): CoreSwapped {
  let n = BigInt(data);

  // tick: int32 (4 bytes)
  const tickRaw = n & ((1n << 32n) - 1n);
  const tickAfter = Number(toSigned(tickRaw, 32));
  n >>= 32n;

  // sqrtRatio: uint96 (12 bytes)
  const sqrtRatioAfterCompact = n & ((1n << 96n) - 1n);
  n >>= 96n;

  const sqrtRatioAfter = toFixed(sqrtRatioAfterCompact);

  // liquidity: uint128 (16 bytes)
  const liquidityAfter = n & ((1n << 128n) - 1n);
  n >>= 128n;

  // delta1: int128 (16 bytes)
  const delta1Raw = n & ((1n << 128n) - 1n);
  const delta1 = toSigned(delta1Raw, 128);
  n >>= 128n;

  // delta0: int128 (16 bytes)
  const delta0Raw = n & ((1n << 128n) - 1n);
  const delta0 = toSigned(delta0Raw, 128);
  n >>= 128n;

  // poolId: bytes32 (32 bytes)
  const poolIdBigInt = n & ((1n << 256n) - 1n);
  const poolId = numberToHex(poolIdBigInt, { size: 32 });
  n >>= 256n;

  // locker: address (20 bytes)
  const lockerBigInt = n & ((1n << 160n) - 1n);
  const locker = checksumAddress(numberToHex(lockerBigInt, { size: 20 }));

  return {
    locker,
    poolId,
    delta0,
    delta1,
    liquidityAfter,
    sqrtRatioAfter,
    tickAfter,
  };
}
