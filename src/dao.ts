import type { PoolClient } from "pg";
import { Client } from "pg";
import type { EventKey } from "./processor";
import { parsePoolKeyConfig, toKeyHash, toPoolId } from "./poolKey.ts";
import type {
  CoreExtensionRegistered,
  CoreFeesAccumulated,
  CorePoolInitialized,
  CorePositionFeesCollected,
  CorePositionUpdated,
  CoreProtocolFeesWithdrawn,
  PoolKey,
  PositionTransfer,
} from "./eventTypes.ts";
import type { CoreSwapped } from "./v2SwapEvent.ts";
import type { V2OracleEvent } from "./v2OracleEvent.ts";

// Data access object that manages inserts/deletes
export class DAO {
  private pg: Client | PoolClient;

  constructor(pg: Client | PoolClient) {
    this.pg = pg;
  }

  public async beginTransaction(): Promise<void> {
    await this.pg.query("BEGIN");
  }

  public async commitTransaction(): Promise<void> {
    await this.pg.query("COMMIT");
  }

  public async initializeSchema() {
    await this.beginTransaction();
    await this.createSchema();
    const cursor = await this.loadCursor();
    // we need to clear anything that was potentially inserted as pending before starting
    if (cursor) {
      await this.deleteOldBlockNumbers(Number(cursor.orderKey) + 1);
    }
    await this.commitTransaction();
    return cursor;
  }

  private async createSchema(): Promise<void> {
    await this.pg.query(`
        CREATE TABLE IF NOT EXISTS cursor
        (
            id           INT         NOT NULL UNIQUE CHECK (id = 1), -- only one row.
            order_key    BIGINT      NOT NULL,
            unique_key   bytea,
            last_updated timestamptz NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blocks
        (
            -- int4 blocks represents over a thousand years at 12 second blocks
            number   int4        NOT NULL PRIMARY KEY,
            hash     NUMERIC     NOT NULL,
            time     timestamptz NOT NULL,
            inserted timestamptz NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks USING btree (time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks USING btree (hash);

        CREATE TABLE IF NOT EXISTS pool_keys
        (
            key_hash     NUMERIC NOT NULL,
            core_address NUMERIC NOT NULL,
            pool_id      NUMERIC NOT NULL,
            token0       NUMERIC NOT NULL,
            token1       NUMERIC NOT NULL,
            fee          NUMERIC NOT NULL,
            tick_spacing INT     NOT NULL,
            extension    NUMERIC NOT NULL,
            PRIMARY KEY (key_hash)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_keys_core_address_pool_id ON pool_keys USING btree (core_address, pool_id);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token1 ON pool_keys USING btree (token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token1 ON pool_keys USING btree (token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token0_token1 ON pool_keys USING btree (token0, token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_extension ON pool_keys USING btree (extension);

        -- all events reference an event id which contains the metadata of the event
        CREATE TABLE IF NOT EXISTS event_keys
        (
            id                int8 GENERATED ALWAYS AS (block_number * 4294967296 + transaction_index * 65536 + event_index) STORED PRIMARY KEY,
            transaction_hash  NUMERIC NOT NULL,
            block_number      int4    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index int2    NOT NULL,
            event_index       int2    NOT NULL,
            emitter           NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_keys_block_number_transaction_index_event_index ON event_keys USING btree (block_number, transaction_index, event_index);
        CREATE INDEX IF NOT EXISTS idx_event_keys_transaction_hash ON event_keys USING btree (transaction_hash);

        CREATE TABLE IF NOT EXISTS position_transfers
        (
            event_id     int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            token_id     int8    NOT NULL,
            from_address NUMERIC NOT NULL,
            to_address   NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_transfers_token_id_from_to ON position_transfers (token_id, from_address, to_address);
        CREATE INDEX IF NOT EXISTS idx_position_transfers_to_address ON position_transfers (to_address);

        CREATE TABLE IF NOT EXISTS position_updates
        (
            event_id        int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            locker          NUMERIC NOT NULL,

            pool_key_hash   NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            salt            NUMERIC NOT NULL,
            lower_bound     int4    NOT NULL,
            upper_bound     int4    NOT NULL,

            liquidity_delta NUMERIC NOT NULL,
            delta0          NUMERIC NOT NULL,
            delta1          NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_updates_pool_key_hash_event_id ON position_updates USING btree (pool_key_hash, event_id);
        CREATE INDEX IF NOT EXISTS idx_position_updates_locker_salt ON position_updates USING btree (locker, salt);
        CREATE INDEX IF NOT EXISTS idx_position_updates_salt ON position_updates USING btree (salt);

        CREATE TABLE IF NOT EXISTS position_fees_collected
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            owner         NUMERIC NOT NULL,
            salt          NUMERIC NOT NULL,
            lower_bound   int4    NOT NULL,
            upper_bound   int4    NOT NULL,

            delta0        NUMERIC NOT NULL,
            delta1        NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_pool_key_hash ON position_fees_collected (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_salt ON position_fees_collected USING btree (salt);


        CREATE TABLE IF NOT EXISTS protocol_fees_withdrawn
        (
            event_id  int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            recipient NUMERIC NOT NULL,
            token     NUMERIC NOT NULL,
            amount    NUMERIC NOT NULL
        );


        CREATE TABLE IF NOT EXISTS fees_accumulated
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            amount0       NUMERIC NOT NULL,
            amount1       NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fees_accumulated_pool_key_hash ON fees_accumulated (pool_key_hash);

        CREATE TABLE IF NOT EXISTS extension_registrations
        (
            event_id  int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,
            extension NUMERIC NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pool_initializations
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            tick          int4    NOT NULL,
            sqrt_ratio    NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pool_initializations_pool_key_hash ON pool_initializations (pool_key_hash);


        CREATE TABLE IF NOT EXISTS swaps
        (
            event_id         int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            locker           NUMERIC NOT NULL,
            pool_key_hash    NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            delta0           NUMERIC NOT NULL,
            delta1           NUMERIC NOT NULL,

            sqrt_ratio_after NUMERIC NOT NULL,
            tick_after       int4    NOT NULL,
            liquidity_after  NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_hash_event_id ON swaps USING btree (pool_key_hash, event_id);

        CREATE OR REPLACE VIEW pool_states_view AS
        (
        WITH lss AS (SELECT key_hash,
                            COALESCE(last_swap.event_id, pi.event_id)           AS last_swap_event_id,
                            COALESCE(last_swap.sqrt_ratio_after, pi.sqrt_ratio) AS sqrt_ratio,
                            COALESCE(last_swap.tick_after, pi.tick)             AS tick,
                            COALESCE(last_swap.liquidity_after, 0)              AS liquidity_last
                     FROM pool_keys
                              LEFT JOIN LATERAL (
                         SELECT event_id, sqrt_ratio_after, tick_after, liquidity_after
                         FROM swaps
                         WHERE pool_keys.key_hash = swaps.pool_key_hash
                         ORDER BY event_id DESC
                         LIMIT 1
                         ) AS last_swap ON TRUE
                              LEFT JOIN LATERAL (
                         SELECT event_id, sqrt_ratio, tick
                         FROM pool_initializations
                         WHERE pool_initializations.pool_key_hash = pool_keys.key_hash
                         ORDER BY event_id DESC
                         LIMIT 1
                         ) AS pi ON TRUE),
             pl AS (SELECT key_hash,
                           (SELECT event_id
                            FROM position_updates
                            WHERE key_hash = position_updates.pool_key_hash
                            ORDER BY event_id DESC
                            LIMIT 1)                                   AS last_update_event_id,
                           (COALESCE(liquidity_last, 0) + COALESCE((SELECT SUM(liquidity_delta)
                                                                    FROM position_updates AS pu
                                                                    WHERE lss.last_swap_event_id < pu.event_id
                                                                      AND pu.pool_key_hash = lss.key_hash
                                                                      AND lss.tick BETWEEN pu.lower_bound AND (pu.upper_bound - 1)),
                                                                   0)) AS liquidity
                    FROM lss)
        SELECT lss.key_hash                                              AS pool_key_hash,
               sqrt_ratio,
               tick,
               liquidity,
               GREATEST(lss.last_swap_event_id, pl.last_update_event_id) AS last_event_id,
               pl.last_update_event_id                                   AS last_liquidity_update_event_id
        FROM lss
                 JOIN pl ON lss.key_hash = pl.key_hash
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS pool_states_materialized AS
        (
        SELECT pool_key_hash, last_event_id, last_liquidity_update_event_id, sqrt_ratio, liquidity, tick
        FROM pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_states_materialized_pool_key_hash ON pool_states_materialized USING btree (pool_key_hash);

        CREATE TABLE IF NOT EXISTS hourly_volume_by_token
        (
            key_hash   NUMERIC,
            hour       timestamptz,
            token      NUMERIC,
            volume     NUMERIC,
            fees       NUMERIC,
            swap_count NUMERIC,
            PRIMARY KEY (key_hash, hour, token)
        );

        CREATE TABLE IF NOT EXISTS hourly_tvl_delta_by_token
        (
            key_hash NUMERIC,
            hour     timestamptz,
            token    NUMERIC,
            delta    NUMERIC,
            PRIMARY KEY (key_hash, hour, token)
        );

        CREATE TABLE IF NOT EXISTS hourly_revenue_by_token
        (
            key_hash NUMERIC,
            hour     timestamptz,
            token    NUMERIC,
            revenue  NUMERIC,
            PRIMARY KEY (key_hash, hour, token)
        );

        CREATE OR REPLACE VIEW per_pool_per_tick_liquidity_view AS
        (
        WITH all_tick_deltas AS (SELECT pool_key_hash,
                                        lower_bound AS       tick,
                                        SUM(liquidity_delta) net_liquidity_delta,
                                        SUM(liquidity_delta) total_liquidity_on_tick
                                 FROM position_updates
                                 GROUP BY pool_key_hash, lower_bound
                                 UNION ALL
                                 SELECT pool_key_hash,
                                        upper_bound AS        tick,
                                        SUM(-liquidity_delta) net_liquidity_delta,
                                        SUM(liquidity_delta)  total_liquidity_on_tick
                                 FROM position_updates
                                 GROUP BY pool_key_hash, upper_bound),
             summed AS (SELECT pool_key_hash,
                               tick,
                               SUM(net_liquidity_delta)     AS net_liquidity_delta_diff,
                               SUM(total_liquidity_on_tick) AS total_liquidity_on_tick
                        FROM all_tick_deltas
                        GROUP BY pool_key_hash, tick)
        SELECT pool_key_hash, tick, net_liquidity_delta_diff, total_liquidity_on_tick
        FROM summed
        WHERE net_liquidity_delta_diff != 0
        ORDER BY tick);

        CREATE TABLE IF NOT EXISTS per_pool_per_tick_liquidity_incremental_view
        (
            pool_key_hash            NUMERIC,
            tick                     int4,
            net_liquidity_delta_diff NUMERIC,
            total_liquidity_on_tick  NUMERIC,
            PRIMARY KEY (pool_key_hash, tick)
        );

        DELETE
        FROM per_pool_per_tick_liquidity_incremental_view;
        INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_hash, tick, net_liquidity_delta_diff,
                                                                  total_liquidity_on_tick)
            (SELECT pool_key_hash, tick, net_liquidity_delta_diff, total_liquidity_on_tick
             FROM per_pool_per_tick_liquidity_view);

        CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_insert()
            RETURNS TRIGGER AS
        $$
        BEGIN
            -- Update or insert for lower_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff + new.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick + new.liquidity_delta
            WHERE pool_key_hash = new.pool_key_hash
              AND tick = new.lower_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_hash, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (new.pool_key_hash, new.lower_bound, new.liquidity_delta, new.liquidity_delta);
            END IF;

            -- Delete if total_liquidity_on_tick is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_hash = new.pool_key_hash
              AND tick = new.lower_bound
              AND total_liquidity_on_tick = 0;

            -- Update or insert for upper_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff - new.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick + new.liquidity_delta
            WHERE pool_key_hash = new.pool_key_hash
              AND tick = new.upper_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_hash, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (new.pool_key_hash, new.upper_bound, -new.liquidity_delta, new.liquidity_delta);
            END IF;

            -- Delete if net_liquidity_delta_diff is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_hash = new.pool_key_hash
              AND tick = new.upper_bound
              AND total_liquidity_on_tick = 0;

            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_delete()
            RETURNS TRIGGER AS
        $$
        BEGIN
            -- Reverse effect for lower_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff - old.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick - old.liquidity_delta
            WHERE pool_key_hash = old.pool_key_hash
              AND tick = old.lower_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_hash, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (old.pool_key_hash, old.lower_bound, -old.liquidity_delta, -old.liquidity_delta);
            END IF;

            -- Delete if net_liquidity_delta_diff is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_hash = old.pool_key_hash
              AND tick = old.lower_bound
              AND total_liquidity_on_tick = 0;

            -- Reverse effect for upper_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff + old.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick - old.liquidity_delta
            WHERE pool_key_hash = old.pool_key_hash
              AND tick = old.upper_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_hash, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (old.pool_key_hash, old.upper_bound, old.liquidity_delta, -old.liquidity_delta);
            END IF;

            -- Delete if net_liquidity_delta_diff is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_hash = old.pool_key_hash
              AND tick = old.upper_bound
              AND total_liquidity_on_tick = 0;

            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_update()
            RETURNS TRIGGER AS
        $$
        BEGIN
            -- Reverse OLD row effects (similar to DELETE)
            PERFORM net_liquidity_deltas_after_delete();

            -- Apply NEW row effects (similar to INSERT)
            PERFORM net_liquidity_deltas_after_insert();

            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_insert
            AFTER INSERT
            ON position_updates
            FOR EACH ROW
        EXECUTE FUNCTION net_liquidity_deltas_after_insert();

        CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_delete
            AFTER DELETE
            ON position_updates
            FOR EACH ROW
        EXECUTE FUNCTION net_liquidity_deltas_after_delete();

        CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_update
            AFTER UPDATE
            ON position_updates
            FOR EACH ROW
        EXECUTE FUNCTION net_liquidity_deltas_after_update();

        CREATE TABLE IF NOT EXISTS oracle_snapshots
        (
            event_id                                  int8    NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            token                                     NUMERIC NOT NULL,
            snapshot_block_timestamp                  int8    NOT NULL,
            snapshot_tick_cumulative                  NUMERIC NOT NULL,
            snapshot_seconds_per_liquidity_cumulative NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_snapshots_token_snapshot_block_timestamp ON oracle_snapshots USING btree (token, snapshot_block_timestamp);

        CREATE OR REPLACE VIEW last_24h_pool_stats_view AS
        (
        WITH volume AS (SELECT vbt.key_hash,
                               SUM(CASE WHEN vbt.token = token0 THEN vbt.volume ELSE 0 END) AS volume0,
                               SUM(CASE WHEN vbt.token = token1 THEN vbt.volume ELSE 0 END) AS volume1,
                               SUM(CASE WHEN vbt.token = token0 THEN vbt.fees ELSE 0 END)   AS fees0,
                               SUM(CASE WHEN vbt.token = token1 THEN vbt.fees ELSE 0 END)   AS fees1
                        FROM hourly_volume_by_token vbt
                                 JOIN pool_keys ON vbt.key_hash = pool_keys.key_hash
                        WHERE hour >= NOW() - INTERVAL '24 hours'
                        GROUP BY vbt.key_hash),
             tvl_total AS (SELECT tbt.key_hash,
                                  SUM(CASE WHEN token = token0 THEN delta ELSE 0 END) AS tvl0,
                                  SUM(CASE WHEN token = token1 THEN delta ELSE 0 END) AS tvl1
                           FROM hourly_tvl_delta_by_token tbt
                                    JOIN pool_keys pk ON tbt.key_hash = pk.key_hash
                           GROUP BY tbt.key_hash),
             tvl_delta_24h AS (SELECT tbt.key_hash,
                                      SUM(CASE WHEN token = token0 THEN delta ELSE 0 END) AS tvl0,
                                      SUM(CASE WHEN token = token1 THEN delta ELSE 0 END) AS tvl1
                               FROM hourly_tvl_delta_by_token tbt
                                        JOIN pool_keys pk ON tbt.key_hash = pk.key_hash
                               WHERE hour >= NOW() - INTERVAL '24 hours'
                               GROUP BY tbt.key_hash)
        SELECT pool_keys.key_hash,
               COALESCE(volume.volume0, 0)     AS volume0_24h,
               COALESCE(volume.volume1, 0)     AS volume1_24h,
               COALESCE(volume.fees0, 0)       AS fees0_24h,
               COALESCE(volume.fees1, 0)       AS fees1_24h,
               COALESCE(tvl_total.tvl0, 0)     AS tvl0_total,
               COALESCE(tvl_total.tvl1, 0)     AS tvl1_total,
               COALESCE(tvl_delta_24h.tvl0, 0) AS tvl0_delta_24h,
               COALESCE(tvl_delta_24h.tvl1, 0) AS tvl1_delta_24h
        FROM pool_keys
                 LEFT JOIN volume ON volume.key_hash = pool_keys.key_hash
                 LEFT JOIN
             tvl_total ON pool_keys.key_hash = tvl_total.key_hash
                 LEFT JOIN tvl_delta_24h
                           ON tvl_delta_24h.key_hash = pool_keys.key_hash
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS last_24h_pool_stats_materialized AS
        (
        SELECT key_hash,
               volume0_24h,
               volume1_24h,
               fees0_24h,
               fees1_24h,
               tvl0_total,
               tvl1_total,
               tvl0_delta_24h,
               tvl1_delta_24h
        FROM last_24h_pool_stats_view
            );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_last_24h_pool_stats_materialized_key_hash ON last_24h_pool_stats_materialized USING btree (key_hash);

        CREATE OR REPLACE VIEW oracle_pool_states_view AS
        (
        SELECT pk.key_hash AS pool_key_hash, MAX(snapshot_block_timestamp) AS last_snapshot_block_timestamp
        FROM oracle_snapshots os
                 JOIN event_keys ek ON ek.id = os.event_id
                 JOIN pool_keys pk ON ek.emitter = pk.extension
        GROUP BY pk.key_hash);

        CREATE MATERIALIZED VIEW IF NOT EXISTS oracle_pool_states_materialized AS
        (
        SELECT pool_key_hash,
               last_snapshot_block_timestamp
        FROM oracle_pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_pool_states_materialized_pool_key_hash ON oracle_pool_states_materialized USING btree (pool_key_hash);
    `);
  }

  public async refreshAnalyticalTables({ since }: { since: Date }) {
    await this.pg.query({
      text: `
                INSERT INTO hourly_volume_by_token
                    (SELECT swaps.pool_key_hash                                                      AS   key_hash,
                            DATE_TRUNC('hour', blocks.time)                                          AS   hour,
                            (CASE WHEN swaps.delta0 >= 0 THEN pool_keys.token0 ELSE pool_keys.token1 END) token,
                            SUM(CASE WHEN swaps.delta0 >= 0 THEN swaps.delta0 ELSE swaps.delta1 END) AS   volume,
                            SUM(FLOOR(((CASE WHEN delta0 >= 0 THEN swaps.delta0 ELSE swaps.delta1 END) *
                                       pool_keys.fee) /
                                      340282366920938463463374607431768211456))                      AS   fees,
                            COUNT(1)                                                                 AS   swap_count
                     FROM swaps
                              JOIN pool_keys ON swaps.pool_key_hash = pool_keys.key_hash
                              JOIN event_keys ON swaps.event_id = event_keys.id
                              JOIN blocks ON event_keys.block_number = blocks.number
                     WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                     GROUP BY hour, swaps.pool_key_hash, token)
                ON CONFLICT (key_hash, hour, token)
                    DO UPDATE SET volume     = excluded.volume,
                                  fees       = excluded.fees,
                                  swap_count = excluded.swap_count;
            `,
      values: [since],
    });

    await this.pg.query({
      text: `
                INSERT INTO hourly_volume_by_token
                    (SELECT fa.pool_key_hash                AS key_hash,
                            DATE_TRUNC('hour', blocks.time) AS hour,
                            pool_keys.token0                AS token,
                            0                               AS volume,
                            SUM(fa.amount0)                 AS fees,
                            0                               AS swap_count
                     FROM fees_accumulated fa
                              JOIN pool_keys ON fa.pool_key_hash = pool_keys.key_hash
                              JOIN event_keys ON fa.event_id = event_keys.id
                              JOIN blocks ON event_keys.block_number = blocks.number
                     WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                       AND fa.amount0 > 0
                     GROUP BY hour, fa.pool_key_hash, token)
                ON CONFLICT (key_hash, hour, token)
                    DO UPDATE SET fees = excluded.fees + hourly_volume_by_token.fees;
            `,
      values: [since],
    });

    await this.pg.query({
      text: `
                INSERT INTO hourly_volume_by_token
                    (SELECT fa.pool_key_hash                AS key_hash,
                            DATE_TRUNC('hour', blocks.time) AS hour,
                            pool_keys.token1                AS token,
                            0                               AS volume,
                            SUM(fa.amount1)                 AS fees,
                            0                               AS swap_count
                     FROM fees_accumulated fa
                              JOIN pool_keys ON fa.pool_key_hash = pool_keys.key_hash
                              JOIN event_keys ON fa.event_id = event_keys.id
                              JOIN blocks ON event_keys.block_number = blocks.number
                     WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                       AND fa.amount1 > 0
                     GROUP BY hour, fa.pool_key_hash, token)
                ON CONFLICT (key_hash, hour, token)
                    DO UPDATE SET fees = excluded.fees + hourly_volume_by_token.fees;
            `,
      values: [since],
    });

    await this.pg.query({
      text: `
          INSERT INTO hourly_revenue_by_token
              (WITH rev0 AS (SELECT pu.pool_key_hash                AS key_hash,
                                    DATE_TRUNC('hour', blocks.time) AS hour,
                                    pk.token0                          token,
                                    SUM(CEIL((-delta0 * pk.fee) /
                                             (0x100000000000000000000000000000000::NUMERIC - pk.fee)) +
                                        delta0)                     AS revenue
                             FROM position_updates pu
                                      JOIN pool_keys pk ON pu.pool_key_hash = pk.key_hash
                                      JOIN event_keys ek ON pu.event_id = ek.id
                                      JOIN blocks ON ek.block_number = blocks.number
                             WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                               AND pu.delta0 < 0
                             GROUP BY hour, pu.pool_key_hash, token),
                    rev1 AS (SELECT pu.pool_key_hash                AS key_hash,
                                    DATE_TRUNC('hour', blocks.time) AS hour,
                                    pk.token1                          token,
                                    SUM(CEIL((-delta0 * pk.fee) /
                                             (0x100000000000000000000000000000000::NUMERIC - pk.fee)) +
                                        delta0)                     AS revenue
                             FROM position_updates pu
                                      JOIN pool_keys pk ON pu.pool_key_hash = pk.key_hash
                                      JOIN event_keys ek ON pu.event_id = ek.id
                                      JOIN blocks ON ek.block_number = blocks.number
                             WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                               AND pu.delta1 < 0
                             GROUP BY hour, pu.pool_key_hash, token),
                    total AS (SELECT key_hash, hour, token, revenue
                              FROM rev0
                              UNION ALL
                              SELECT key_hash, hour, token, revenue
                              FROM rev1)
               SELECT key_hash, hour, token, SUM(revenue) AS revenue
               FROM total
               GROUP BY key_hash, hour, token)
          ON CONFLICT (key_hash, hour, token)
              DO UPDATE SET revenue = excluded.revenue;
      `,
      values: [since],
    });

    await this.pg.query({
      text: `
          INSERT INTO hourly_tvl_delta_by_token
              (WITH first_event_id AS (SELECT id
                                       FROM event_keys AS ek
                                                JOIN blocks AS b ON ek.block_number = b.number
                                       WHERE b.time >= DATE_TRUNC('hour', $1::timestamptz)
                                       LIMIT 1),
                    grouped_pool_key_hash_deltas AS (SELECT pool_key_hash,
                                                            DATE_TRUNC('hour', blocks.time) AS hour,
                                                            SUM(delta0)                     AS delta0,
                                                            SUM(delta1)                     AS delta1
                                                     FROM swaps
                                                              JOIN event_keys ON swaps.event_id = event_keys.id
                                                              JOIN blocks ON event_keys.block_number = blocks.number
                                                     WHERE event_id >= (SELECT id FROM first_event_id)
                                                     GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                     UNION ALL

                                                     SELECT pool_key_hash,
                                                            DATE_TRUNC('hour', blocks.time) AS hour,
                                                            SUM(CASE
                                                                    WHEN liquidity_delta < 0 THEN CEIL(
                                                                            (delta0 * 0x100000000000000000000000000000000::NUMERIC) /
                                                                            (0x100000000000000000000000000000000::NUMERIC - pk.fee))
                                                                    ELSE delta0 END)        AS delta0,
                                                            SUM(CASE
                                                                    WHEN liquidity_delta < 0 THEN CEIL(
                                                                            (delta1 * 0x100000000000000000000000000000000::NUMERIC) /
                                                                            (0x100000000000000000000000000000000::NUMERIC - pk.fee))
                                                                    ELSE delta1 END)        AS delta1
                                                     FROM position_updates pu
                                                              JOIN event_keys ON pu.event_id = event_keys.id
                                                              JOIN blocks ON event_keys.block_number = blocks.number
                                                              JOIN pool_keys pk ON pu.pool_key_hash = pk.key_hash
                                                     WHERE event_id >= (SELECT id FROM first_event_id)
                                                     GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                     UNION ALL

                                                     SELECT pool_key_hash,
                                                            DATE_TRUNC('hour', blocks.time) AS hour,
                                                            SUM(delta0)                     AS delta0,
                                                            SUM(delta1)                     AS delta1
                                                     FROM position_fees_collected
                                                              JOIN event_keys ON position_fees_collected.event_id = event_keys.id
                                                              JOIN blocks ON event_keys.block_number = blocks.number
                                                     WHERE event_id >= (SELECT id FROM first_event_id)
                                                     GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                     UNION ALL

                                                     SELECT pool_key_hash,
                                                            DATE_TRUNC('hour', blocks.time) AS hour,
                                                            SUM(amount0)                    AS delta0,
                                                            SUM(amount1)                    AS delta1
                                                     FROM fees_accumulated
                                                              JOIN event_keys ON fees_accumulated.event_id = event_keys.id
                                                              JOIN blocks ON event_keys.block_number = blocks.number
                                                     WHERE event_id >= (SELECT id FROM first_event_id)
                                                     GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)),
                    token_deltas AS (SELECT pool_key_hash,
                                            grouped_pool_key_hash_deltas.hour,
                                            pool_keys.token0 AS token,
                                            SUM(delta0)      AS delta
                                     FROM grouped_pool_key_hash_deltas
                                              JOIN pool_keys
                                                   ON pool_keys.key_hash = grouped_pool_key_hash_deltas.pool_key_hash
                                     GROUP BY pool_key_hash, grouped_pool_key_hash_deltas.hour,
                                              pool_keys.token0

                                     UNION ALL

                                     SELECT pool_key_hash,
                                            grouped_pool_key_hash_deltas.hour,
                                            pool_keys.token1 AS token,
                                            SUM(delta1)      AS delta
                                     FROM grouped_pool_key_hash_deltas
                                              JOIN pool_keys
                                                   ON pool_keys.key_hash = grouped_pool_key_hash_deltas.pool_key_hash
                                     GROUP BY pool_key_hash, grouped_pool_key_hash_deltas.hour,
                                              pool_keys.token1)
               SELECT pool_key_hash AS key_hash,
                      token_deltas.hour,
                      token_deltas.token,
                      SUM(delta)    AS delta
               FROM token_deltas
               GROUP BY token_deltas.pool_key_hash, token_deltas.hour, token_deltas.token)
          ON CONFLICT (key_hash, hour, token)
              DO UPDATE SET delta = excluded.delta;
      `,
      values: [since],
    });

    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY last_24h_pool_stats_materialized;
    `);
  }

  public async refreshOperationalMaterializedView() {
    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY oracle_pool_states_materialized;
    `);
  }

  private async loadCursor(): Promise<
    | {
        orderKey: bigint;
        uniqueKey: `0x${string}`;
      }
    | { orderKey: bigint }
    | null
  > {
    const { rows } = await this.pg.query({
      text: `SELECT order_key, unique_key
                   FROM cursor
                   WHERE id = 1;`,
    });
    if (rows.length === 1) {
      const { order_key, unique_key } = rows[0];

      if (unique_key === null) {
        return {
          orderKey: BigInt(order_key),
        };
      } else {
        return {
          orderKey: BigInt(order_key),
          uniqueKey: `0x${BigInt(unique_key).toString(16)}`,
        };
      }
    } else {
      return null;
    }
  }

  public async writeCursor(cursor: { orderKey: bigint; uniqueKey?: string }) {
    await this.pg.query({
      text: `
          INSERT INTO cursor (id, order_key, unique_key, last_updated)
          VALUES (1, $1, $2, NOW())
          ON CONFLICT (id) DO UPDATE SET order_key    = excluded.order_key,
                                         unique_key   = excluded.unique_key,
                                         last_updated = NOW();
      `,
      values: [
        cursor.orderKey,
        typeof cursor.uniqueKey !== "undefined"
          ? BigInt(cursor.uniqueKey)
          : null,
      ],
    });
  }

  public async insertBlock({
    number,
    hash,
    time,
  }: {
    number: bigint;
    hash: bigint;
    time: Date;
  }) {
    await this.pg.query({
      text: `INSERT INTO blocks (number, hash, time)
                   VALUES ($1, $2, $3);`,
      values: [number, hash, time],
    });
  }

  private async insertPoolKey(
    coreAddress: `0x${string}`,
    poolKey: PoolKey,
    poolId: `0x${string}` = toPoolId(poolKey),
  ): Promise<`0x${string}`> {
    const keyHash = toKeyHash(coreAddress, poolId);

    const { fee, tickSpacing, extension } =
      "config" in poolKey ? parsePoolKeyConfig(poolKey.config) : poolKey;

    await this.pg.query({
      text: `
          INSERT INTO pool_keys (key_hash,
                                 pool_id,
                                 core_address,
                                 token0,
                                 token1,
                                 fee,
                                 tick_spacing,
                                 extension)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING;
      `,
      values: [
        keyHash,
        poolId,
        coreAddress,
        BigInt(poolKey.token0),
        BigInt(poolKey.token1),
        fee,
        tickSpacing,
        BigInt(extension),
      ],
    });
    return keyHash;
  }

  public async insertPositionTransferEvent(
    transfer: PositionTransfer,
    key: EventKey,
  ) {
    // The `*` operator is the PostgreSQL range intersection operator.
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO position_transfers
                (event_id,
                 token_id,
                 from_address,
                 to_address)
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        transfer.id,
        transfer.from,
        transfer.to,
      ],
    });
  }

  public async insertPositionUpdatedEvent(
    event: CorePositionUpdated,
    key: EventKey,
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                  VALUES ($1, $2, $3, $4, $5)
                  RETURNING id)
          INSERT
          INTO position_updates
          (event_id,
           locker,
           pool_key_hash,
           salt,
           lower_bound,
           upper_bound,
           liquidity_delta,
           delta0,
           delta1)
          VALUES ((SELECT id FROM inserted_event), $6,
                  (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $7),
                  $8, $9, $10, $11, $12, $13);
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.locker,

        "poolId" in event ? event.poolId : toPoolId(event.poolKey),

        event.params.salt,
        event.params.bounds.lower,
        event.params.bounds.upper,

        event.params.liquidityDelta,
        event.delta0,
        event.delta1,
      ],
    });
  }

  public async insertPositionFeesCollectedEvent(
    event: CorePositionFeesCollected,
    key: EventKey,
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                  VALUES ($1, $2, $3, $4, $5)
                  RETURNING id)
          INSERT
          INTO position_fees_collected
          (event_id,
           pool_key_hash,
           owner,
           salt,
           lower_bound,
           upper_bound,
           delta0,
           delta1)
          VALUES ((SELECT id FROM inserted_event),
                  (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $6),
                  $7, $8, $9, $10, $11, $12);
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        "poolId" in event ? event.poolId : toPoolId(event.poolKey),

        event.positionKey.owner,
        event.positionKey.salt,
        event.positionKey.bounds.lower,
        event.positionKey.bounds.upper,

        event.amount0,
        event.amount1,
      ],
    });
  }

  public async insertPoolInitializedEvent(
    event: CorePoolInitialized,
    key: EventKey,
  ) {
    const poolKeyHash = await this.insertPoolKey(key.emitter, event.poolKey);

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO pool_initializations
                (event_id,
                 pool_key_hash,
                 tick,
                 sqrt_ratio)
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        poolKeyHash,

        event.tick,
        event.sqrtRatio,
      ],
    });
  }

  public async insertProtocolFeesWithdrawn(
    event: CoreProtocolFeesWithdrawn,
    key: EventKey,
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO protocol_fees_withdrawn
                (event_id,
                 recipient,
                 token,
                 amount)
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.recipient,
        event.token,
        event.amount,
      ],
    });
  }

  public async insertExtensionRegistered(
    event: CoreExtensionRegistered,
    key: EventKey,
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                  VALUES ($1, $2, $3, $4, $5)
                  RETURNING id)
          INSERT
          INTO extension_registrations
              (event_id, extension)
          VALUES ((SELECT id FROM inserted_event), $6);
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.extension,
      ],
    });
  }

  public async insertFeesAccumulatedEvent(
    event: CoreFeesAccumulated,
    key: EventKey,
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                  VALUES ($1, $2, $3, $4, $5)
                  RETURNING id)
          INSERT
          INTO fees_accumulated
          (event_id,
           pool_key_hash,
           amount0,
           amount1)
          VALUES ((SELECT id FROM inserted_event),
                  (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $7),
                  $8, $9);
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        "poolId" in event ? event.poolId : toPoolId(event.poolKey),

        event.amount0,
        event.amount1,
      ],
    });
  }

  public async insertSwappedEvent(event: CoreSwapped, key: EventKey) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                  VALUES ($1, $2, $3, $4, $5)
                  RETURNING id)
          INSERT
          INTO swaps
          (event_id,
           locker,
           pool_key_hash,
           delta0,
           delta1,
           sqrt_ratio_after,
           tick_after,
           liquidity_after)
          VALUES ((SELECT id FROM inserted_event), $6,
                  (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $7),
                  $8, $9, $10, $11, $12);
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.locker,

        event.poolId,

        event.delta0,
        event.delta1,
        event.sqrtRatioAfter,
        event.tickAfter,
        event.liquidityAfter,
      ],
    });
  }

  /**
   * Deletes all the blocks equal to or greater than the given block number, cascades to all the other tables.
   * @param invalidatedBlockNumber the block number for which data in the database should be removed
   */
  public async deleteOldBlockNumbers(invalidatedBlockNumber: number) {
    const { rowCount } = await this.pg.query({
      text: `
                DELETE
                FROM blocks
                WHERE number >= $1;
            `,
      values: [invalidatedBlockNumber],
    });
    if (rowCount === null) throw new Error("Null row count after delete");
    return rowCount;
  }

  async insertOracleSnapshotEvent(parsed: V2OracleEvent, key: EventKey) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO oracle_snapshots
                (event_id, token, snapshot_block_timestamp, snapshot_tick_cumulative, snapshot_seconds_per_liquidity_cumulative)
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8, $9)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.token,
        parsed.timestamp,
        parsed.tickCumulative,
        parsed.secondsPerLiquidityCumulative,
      ],
    });
  }
}
