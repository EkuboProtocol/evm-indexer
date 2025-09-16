import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import { DAO } from "./dao.ts";
import type { CoreSwapped } from "./swapEvent.ts";
import type { EventKey } from "./processor.ts";

describe("Pool Balance Changes", () => {
  let pool: Pool;
  let client: PoolClient;
  let dao: DAO;

  beforeEach(async () => {
    // Skip tests if no test database is configured
    if (!process.env.PG_TEST_CONNECTION_STRING && !process.env.PG_CONNECTION_STRING) {
      return;
    }

    // Use a test database connection
    pool = new Pool({
      connectionString: process.env.PG_TEST_CONNECTION_STRING || process.env.PG_CONNECTION_STRING,
      connectionTimeoutMillis: 1000,
    });
    client = await pool.connect();
    dao = new DAO(client);
    
    // Initialize schema (this handles its own transaction)
    await dao.initializeSchema();
  });

  afterEach(async () => {
    if (client) {
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it("should create pool_balance_changes table with correct structure", async () => {
    // Skip if no database configured
    if (!client) return;

    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'pool_balance_changes'
      ORDER BY ordinal_position;
    `);

    expect(result.rows).toEqual([
      { column_name: "event_id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "pool_key_hash", data_type: "numeric", is_nullable: "NO" },
      { column_name: "delta0", data_type: "numeric", is_nullable: "NO" },
      { column_name: "delta1", data_type: "numeric", is_nullable: "NO" },
      { column_name: "event_type", data_type: "text", is_nullable: "NO" },
    ]);
  });

  it("should insert swap events into pool_balance_changes table", async () => {
    // Skip if no database configured
    if (!client) return;

    // First create a test pool key
    await client.query(`
      INSERT INTO pool_keys (key_hash, core_address, pool_id, token0, token1, fee, tick_spacing, extension)
      VALUES (123, 456, 789, 100, 200, 3000, 60, 0);
    `);

    // Create a test block
    await client.query(`
      INSERT INTO blocks (number, hash, time)
      VALUES (1000, 999, NOW());
    `);

    const swapEvent: CoreSwapped = {
      locker: "0x1234567890123456789012345678901234567890",
      poolId: "0x0000000000000000000000000000000000000000000000000000000000000315", // 789 in hex
      delta0: 1000000n,
      delta1: -500000n,
      liquidityAfter: 2000000n,
      sqrtRatioAfter: 1500000n,
      tickAfter: 100,
    };

    const eventKey: EventKey = {
      blockNumber: 1000,
      transactionIndex: 1,
      eventIndex: 0,
      emitter: "0x00000000000000000000000000000000000001c8", // 456 in hex
      transactionHash: "0xabcdef",
    };

    await dao.beginTransaction();
    await dao.insertSwappedEvent(swapEvent, eventKey);
    await dao.commitTransaction();

    // Verify the swap was inserted into both tables
    const swapResult = await client.query("SELECT * FROM swaps");
    expect(swapResult.rows).toHaveLength(1);

    const balanceChangeResult = await client.query("SELECT * FROM pool_balance_changes");
    expect(balanceChangeResult.rows).toHaveLength(1);
    expect(balanceChangeResult.rows[0]).toMatchObject({
      pool_key_hash: "123",
      delta0: "1000000",
      delta1: "-500000",
      event_type: "swap",
    });
  });

  it("should handle multiple event types in pool_balance_changes", async () => {
    // Skip if no database configured
    if (!client) return;

    // This test would verify that different event types are properly categorized
    // For now, we'll just verify the table accepts different event types
    
    await client.query(`
      INSERT INTO pool_keys (key_hash, core_address, pool_id, token0, token1, fee, tick_spacing, extension)
      VALUES (123, 456, 789, 100, 200, 3000, 60, 0);
    `);

    await client.query(`
      INSERT INTO blocks (number, hash, time)
      VALUES (1000, 999, NOW());
    `);

    // Insert different event types
    const eventTypes = ['swap', 'position_update', 'position_fees_collected', 'fees_accumulated', 'twamm_proceeds_withdrawn'];
    
    for (let i = 0; i < eventTypes.length; i++) {
      // Insert event_keys row for each event
      await client.query(`
        INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
        VALUES (1000, 1, $1, '0xabcdef', 456);
      `, [i]);

      // Insert corresponding pool_balance_changes row
      await client.query(`
        INSERT INTO pool_balance_changes (event_id, pool_key_hash, delta0, delta1, event_type)
        VALUES ($1, 123, $2, $3, $4);
      `, [
        1000 * 4294967296 + 1 * 65536 + i, // Generate unique event_id
        (i + 1) * 1000,
        (i + 1) * -500,
        eventTypes[i]
      ]);
    }

    const result = await client.query("SELECT event_type, COUNT(*) as count FROM pool_balance_changes GROUP BY event_type ORDER BY event_type");
    expect(result.rows).toHaveLength(5);
    expect(result.rows.map(r => r.event_type)).toEqual(eventTypes.sort());
  });
});
