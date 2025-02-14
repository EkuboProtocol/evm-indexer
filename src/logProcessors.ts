import { DAO } from "./dao.ts";
import type { EventKey } from "./processor.ts";
import {
  CORE_ABI,
  CORE_V2_ABI,
  ORACLE_ABI,
  ORACLE_V2_ABI,
  POSITIONS_ABI,
} from "./abis.ts";
import type {
  Abi,
  AbiParameterToPrimitiveType,
  ExtractAbiEvent,
  ExtractAbiEventNames,
} from "abitype";
import {
  type ContractEventName,
  decodeEventLog,
  encodeEventTopics,
} from "viem";
import { logger } from "./logger.ts";
import { parseV2SwapEventData } from "./v2SwapEvent.ts";
import { toPoolId } from "./poolKey.ts";
import { parseV2OracleEvent } from "./v2OracleEvent.ts";

export type ContractEvent<
  abi extends Abi,
  N extends ExtractAbiEventNames<abi>,
> = {
  [P in ExtractAbiEvent<abi, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

interface LogProcessor {
  address: `0x${string}`;

  filter: {
    topics: (`0x${string}` | null)[];
    strict: boolean;
  };

  handler: (
    dao: DAO,
    key: EventKey,
    event: {
      topics: readonly `0x${string}`[];
      data: `0x${string}` | undefined;
    },
  ) => Promise<void>;
}

export function createContractEventProcessor<
  T extends Abi,
  N extends ContractEventName<T>,
>({
  address,
  abi,
  eventName,
  handler: wrappedHandler,
}: {
  address: `0x${string}`;
  abi: T;
  eventName: N;
  handler(dao: DAO, key: EventKey, event: ContractEvent<T, N>): Promise<void>;
}): LogProcessor {
  return {
    address,
    filter: {
      topics: encodeEventTopics({
        abi,
        eventName,
      } as any) as `0x${string}`[],
      strict: false,
    },
    async handler(dao, key, event) {
      if (event.topics.length === 0)
        throw new Error(`Event matched ${eventName} filter with no topics`);

      const result = decodeEventLog({
        abi,
        eventName: eventName,
        topics: event.topics as [`0x${string}`, ...topics: `0x${string}`[]],
        data: event.data,
        strict: true,
      });

      logger.debug(`Processing ${eventName}`, { key, event: result.args });
      await wrappedHandler(dao, key, result.args as any);
    },
  };
}

type HandlerMap<T extends Abi> = {
  [eventName in ContractEventName<T>]?: Parameters<
    typeof createContractEventProcessor<T, eventName>
  >[0]["handler"];
};

type ContractHandlers<T extends Abi> = {
  address: `0x${string}`;
  abi: T;
  handlers?: HandlerMap<T>;
  noTopics?: (
    dao: DAO,
    key: EventKey,
    data: `0x${string}` | undefined,
  ) => Promise<void>;
};

const processors: {
  Core: ContractHandlers<typeof CORE_ABI>;
  Positions: ContractHandlers<typeof POSITIONS_ABI>;
  Oracle: ContractHandlers<typeof ORACLE_ABI>;

  CoreV2: ContractHandlers<typeof CORE_V2_ABI>;
  PositionsV2: ContractHandlers<typeof POSITIONS_ABI>;
  OracleV2: ContractHandlers<typeof ORACLE_V2_ABI>;
} = {
  Core: {
    address: process.env.CORE_ADDRESS,
    abi: CORE_ABI,
    handlers: {
      async PoolInitialized(dao, key, parsed) {
        await dao.insertPoolInitializedEvent(parsed, key);
      },
      async PositionUpdated(dao, key, parsed) {
        await dao.insertPositionUpdatedEvent(parsed, key);
      },
      async PositionFeesCollected(dao, key, parsed) {
        await dao.insertPositionFeesCollectedEvent(parsed, key);
      },
      async Swapped(dao, key, parsed) {
        await dao.insertSwappedEvent(
          {
            poolId: toPoolId(parsed.poolKey),
            delta0: parsed.delta0,
            delta1: parsed.delta1,
            locker: parsed.locker,
            liquidityAfter: parsed.liquidityAfter,
            sqrtRatioAfter: parsed.sqrtRatioAfter,
            tickAfter: parsed.tickAfter,
          },
          key,
        );
      },
      async ProtocolFeesWithdrawn(dao, key, parsed) {
        await dao.insertProtocolFeesWithdrawn(parsed, key);
      },
      async FeesAccumulated(dao, key, parsed) {
        await dao.insertFeesAccumulatedEvent(parsed, key);
      },
      async ExtensionRegistered(dao, key, parsed) {
        await dao.insertExtensionRegistered(parsed, key);
      },
    },
  },
  Positions: {
    address: process.env.POSITIONS_ADDRESS,
    abi: POSITIONS_ABI,
    handlers: {
      async Transfer(dao, key, parsed) {
        await dao.insertPositionTransferEvent(parsed, key);
      },
    },
  },
  Oracle: {
    address: process.env.ORACLE_ADDRESS,
    abi: ORACLE_ABI,
    handlers: {
      async SnapshotEvent(dao, key, parsed) {
        await dao.insertOracleSnapshotEvent(parsed, key);
      },
    },
  },
  CoreV2: {
    address: process.env.CORE_V2_ADDRESS,
    abi: CORE_V2_ABI,
    async noTopics(dao, key, data) {
      if (!data) throw new Error("Event with no data from core");
      const event = parseV2SwapEventData(data);
      logger.debug(`Parsed V2 Swapped Event`, {
        event,
        rawData: data,
      });
      await dao.insertSwappedEvent(event, key);
    },
    handlers: {
      async PoolInitialized(dao, key, parsed) {
        await dao.insertPoolInitializedEvent(parsed, key);
      },
      async PositionUpdated(dao, key, parsed) {
        await dao.insertPositionUpdatedEvent(parsed, key);
      },
      async PositionFeesCollected(dao, key, parsed) {
        await dao.insertPositionFeesCollectedEvent(parsed, key);
      },
      async ProtocolFeesWithdrawn(dao, key, parsed) {
        await dao.insertProtocolFeesWithdrawn(parsed, key);
      },
      async FeesAccumulated(dao, key, parsed) {
        await dao.insertFeesAccumulatedEvent(parsed, key);
      },
      async ExtensionRegistered(dao, key, parsed) {
        await dao.insertExtensionRegistered(parsed, key);
      },
    },
  },
  PositionsV2: {
    address: process.env.POSITIONS_V2_ADDRESS,
    abi: POSITIONS_ABI,
    handlers: {
      async Transfer(dao, key, parsed) {
        await dao.insertPositionTransferEvent(parsed, key);
      },
    },
  },
  OracleV2: {
    address: process.env.ORACLE_V2_ADDRESS,
    abi: ORACLE_V2_ABI,
    async noTopics(dao, key, data) {
      if (!data) throw new Error("Event with no data from Oracle");
      const event = parseV2OracleEvent(data);
      logger.debug(`Parsed V2 Oracle Event`, {
        event,
        rawData: data,
      });
      await dao.insertOracleSnapshotEvent(event, key);
    },
  },
};

export const LOG_PROCESSORS = Object.values(processors).flatMap(
  ({ address, abi, handlers, noTopics }) =>
    (noTopics
      ? [
          <LogProcessor>{
            address,
            filter: {
              topics: [],
              strict: true,
            },
            handler(dao, eventKey, log): Promise<void> {
              return noTopics(dao, eventKey, log.data);
            },
          },
        ]
      : []
    ).concat(
      handlers
        ? Object.entries(handlers).map(
            ([eventName, handler]): LogProcessor =>
              createContractEventProcessor({
                address,
                abi,
                eventName: eventName as ExtractAbiEventNames<typeof abi>,
                handler: handler as any,
              }),
          )
        : [],
    ),
) as LogProcessor[];
