declare namespace NodeJS {
  export interface ProcessEnv {
    NETWORK: "sepolia" | "mainnet" | string;

    LOG_LEVEL: string;

    CORE_ADDRESS: `0x${string}`;
    POSITIONS_ADDRESS: `0x${string}`;
    ORACLE_ADDRESS: `0x${string}`;
    TWAMM_ADDRESS: `0x${string}`;
    ORDERS_ADDRESS: `0x${string}`;

    STARTING_CURSOR_BLOCK_NUMBER: string;

    APIBARA_AUTH_TOKEN: string;

    REFRESH_RATE_ANALYTICAL_VIEWS: string;
    APIBARA_URL: string;

    PG_CONNECTION_STRING: string;
    
    NO_BLOCKS_TIMEOUT_MS: string; // Time in milliseconds before exiting if no blocks are received
  }
}
