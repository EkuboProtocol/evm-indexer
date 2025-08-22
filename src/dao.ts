import type { PoolClient } from "pg";
import { Client } from "pg";
import type { EventKey } from "./processor";
import {
  parsePoolKeyConfig,
  toKeyHash,
  toPoolConfig,
  toPoolId,
} from "./poolKey.ts";
import type {
  CoreExtensionRegistered,
  CoreFeesAccumulated,
  CorePoolInitialized,
  CorePositionFeesCollected,
  CorePositionUpdated,
  CoreProtocolFeesWithdrawn,
  IncentivesFunded,
  IncentivesRefunded,
  OrderTransfer,
  PoolKey,
  PositionTransfer,
  TwammOrderProceedsWithdrawn,
  TwammOrderUpdated,
} from "./eventTypes.ts";
import type { CoreSwapped } from "./swapEvent.ts";
import type { OracleEvent } from "./oracleEvent.ts";
import type { TwammVirtualOrdersExecutedEvent } from "./twammEvent.ts";

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

            token_id     NUMERIC NOT NULL,
            from_address NUMERIC NOT NULL,
            to_address   NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_transfers_token_id_from_to ON position_transfers (token_id, from_address, to_address);
        CREATE INDEX IF NOT EXISTS idx_position_transfers_to_address ON position_transfers (to_address);

        CREATE TABLE IF NOT EXISTS order_transfers
        (
            event_id     int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            token_id     NUMERIC NOT NULL,
            from_address NUMERIC NOT NULL,
            to_address   NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_order_transfers_token_id_from_to ON order_transfers (token_id, from_address, to_address);
        CREATE INDEX IF NOT EXISTS idx_order_transfers_to_address ON order_transfers (to_address);

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
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_hash_event_id_desc ON swaps USING btree (pool_key_hash, event_id DESC) INCLUDE (sqrt_ratio_after, tick_after, liquidity_after);

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

        CREATE TABLE IF NOT EXISTS hourly_price_data
        (
            token0     NUMERIC,
            token1     NUMERIC,
            hour       timestamptz,
            k_volume   NUMERIC,
            total      NUMERIC,
            swap_count NUMERIC,
            PRIMARY KEY (token0, token1, hour)
        );

        CREATE TABLE IF NOT EXISTS hourly_twap_data
        (
            token0                      NUMERIC,
            token1                      NUMERIC,
            hour                        timestamptz,
            liquidity_weighted_tick     NUMERIC,
            total_liquidity_seconds     NUMERIC,
            total_time_seconds          NUMERIC,
            swap_count                  NUMERIC,
            pool_count                  NUMERIC,
            PRIMARY KEY (token0, token1, hour)
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
        FROM per_pool_per_tick_liquidity_incremental_view
        WHERE TRUE;
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

        CREATE TABLE IF NOT EXISTS twamm_order_updates
        (
            event_id         int8        NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            key_hash         NUMERIC     NOT NULL REFERENCES pool_keys (key_hash),

            owner            NUMERIC     NOT NULL,
            salt             NUMERIC     NOT NULL,
            sale_rate_delta0 NUMERIC     NOT NULL,
            sale_rate_delta1 NUMERIC     NOT NULL,
            start_time       timestamptz NOT NULL,
            end_time         timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_key_hash_event_id ON twamm_order_updates USING btree (key_hash, event_id);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_key_hash_time ON twamm_order_updates USING btree (key_hash, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_owner_salt ON twamm_order_updates USING btree (owner, salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_salt ON twamm_order_updates USING btree (salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_salt_key_hash_start_end_owner_event_id ON twamm_order_updates (salt, key_hash, start_time, end_time, owner, event_id);

        CREATE TABLE IF NOT EXISTS twamm_proceeds_withdrawals
        (
            event_id   int8        NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            key_hash   NUMERIC     NOT NULL REFERENCES pool_keys (key_hash),

            owner      NUMERIC     NOT NULL,
            salt       NUMERIC     NOT NULL,
            amount0    NUMERIC     NOT NULL,
            amount1    NUMERIC     NOT NULL,
            start_time timestamptz NOT NULL,
            end_time   timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_key_hash_event_id ON twamm_proceeds_withdrawals USING btree (key_hash, event_id);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_key_hash_time ON twamm_proceeds_withdrawals USING btree (key_hash, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_owner_salt ON twamm_proceeds_withdrawals USING btree (owner, salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_salt ON twamm_proceeds_withdrawals USING btree (salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_salt_event_id_desc ON twamm_proceeds_withdrawals (salt, event_id DESC);

        CREATE TABLE IF NOT EXISTS twamm_virtual_order_executions
        (
            event_id         int8    NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            key_hash         NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            token0_sale_rate NUMERIC NOT NULL,
            token1_sale_rate NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_virtual_order_executions_pool_key_hash_event_id ON twamm_virtual_order_executions USING btree (key_hash, event_id DESC);

        CREATE OR REPLACE VIEW twamm_pool_states_view AS
        (
        WITH lvoe_id AS (SELECT key_hash, MAX(event_id) AS event_id
                         FROM twamm_virtual_order_executions
                         GROUP BY key_hash),

             last_virtual_order_execution AS (SELECT pk.key_hash,
                                                     last_voe.token0_sale_rate,
                                                     last_voe.token1_sale_rate,
                                                     last_voe.event_id AS last_virtual_order_execution_event_id,
                                                     b.time            AS last_virtual_execution_time
                                              FROM pool_keys pk
                                                       JOIN lvoe_id ON lvoe_id.key_hash = pk.key_hash
                                                       JOIN twamm_virtual_order_executions last_voe
                                                            ON last_voe.event_id = lvoe_id.event_id
                                                       JOIN event_keys ek ON last_voe.event_id = ek.id
                                                       JOIN blocks b ON ek.block_number = b.number),
             active_order_updates_after_lvoe AS (SELECT lvoe_1.key_hash,
                                                        SUM(tou.sale_rate_delta0) AS sale_rate_delta0,
                                                        SUM(tou.sale_rate_delta1) AS sale_rate_delta1,
                                                        MAX(tou.event_id)         AS last_order_update_event_id
                                                 FROM last_virtual_order_execution lvoe_1
                                                          JOIN twamm_order_updates tou
                                                               ON tou.key_hash = lvoe_1.key_hash AND
                                                                  tou.event_id >
                                                                  lvoe_1.last_virtual_order_execution_event_id AND
                                                                  tou.start_time <=
                                                                  lvoe_1.last_virtual_execution_time AND
                                                                  tou.end_time >
                                                                  lvoe_1.last_virtual_execution_time
                                                 GROUP BY lvoe_1.key_hash)
        SELECT lvoe.key_hash                                                          AS pool_key_hash,
               lvoe.token0_sale_rate + COALESCE(ou_lvoe.sale_rate_delta0, 0::NUMERIC) AS token0_sale_rate,
               lvoe.token1_sale_rate + COALESCE(ou_lvoe.sale_rate_delta1, 0::NUMERIC) AS token1_sale_rate,
               lvoe.last_virtual_execution_time,
               GREATEST(COALESCE(ou_lvoe.last_order_update_event_id, lvoe.last_virtual_order_execution_event_id),
                        psm.last_event_id)                                            AS last_event_id
        FROM last_virtual_order_execution lvoe
                 JOIN pool_states_materialized psm ON lvoe.key_hash = psm.pool_key_hash
                 LEFT JOIN active_order_updates_after_lvoe ou_lvoe ON lvoe.key_hash = ou_lvoe.key_hash
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS twamm_pool_states_materialized AS
        (
        SELECT pool_key_hash,
               token0_sale_rate,
               token1_sale_rate,
               last_virtual_execution_time,
               last_event_id
        FROM twamm_pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_twamm_pool_states_materialized_key_hash ON twamm_pool_states_materialized USING btree (pool_key_hash);

        CREATE OR REPLACE VIEW twamm_sale_rate_deltas_view AS
        (
        WITH all_order_deltas AS (SELECT key_hash,
                                         start_time AS         time,
                                         SUM(sale_rate_delta0) net_sale_rate_delta0,
                                         SUM(sale_rate_delta1) net_sale_rate_delta1
                                  FROM twamm_order_updates
                                  GROUP BY key_hash, start_time
                                  UNION ALL
                                  SELECT key_hash,
                                         end_time AS            time,
                                         -SUM(sale_rate_delta0) net_sale_rate_delta0,
                                         -SUM(sale_rate_delta1) net_sale_rate_delta1
                                  FROM twamm_order_updates
                                  GROUP BY key_hash, end_time),
             summed AS (SELECT key_hash,
                               time,
                               SUM(net_sale_rate_delta0) AS net_sale_rate_delta0,
                               SUM(net_sale_rate_delta1) AS net_sale_rate_delta1
                        FROM all_order_deltas
                        GROUP BY key_hash, time)
        SELECT key_hash AS pool_key_hash, time, net_sale_rate_delta0, net_sale_rate_delta1
        FROM summed
        WHERE net_sale_rate_delta0 != 0
           OR net_sale_rate_delta1 != 0
        ORDER BY key_hash, time);

        CREATE MATERIALIZED VIEW IF NOT EXISTS twamm_sale_rate_deltas_materialized AS
        (
        SELECT tsrdv.pool_key_hash, tsrdv.time, tsrdv.net_sale_rate_delta0, tsrdv.net_sale_rate_delta1
        FROM twamm_sale_rate_deltas_view AS tsrdv
                 JOIN twamm_pool_states_materialized tpsm
                      ON tpsm.pool_key_hash = tsrdv.pool_key_hash AND
                         tpsm.last_virtual_execution_time < tsrdv.time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_twamm_sale_rate_deltas_materialized_pool_key_hash_time ON twamm_sale_rate_deltas_materialized USING btree (pool_key_hash, time);

        CREATE TABLE IF NOT EXISTS oracle_snapshots
        (
            event_id                                  int8    NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            token                                     NUMERIC NOT NULL,
            snapshot_block_timestamp                  int8    NOT NULL,
            snapshot_tick_cumulative                  NUMERIC NOT NULL,
            snapshot_seconds_per_liquidity_cumulative NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_snapshots_token_snapshot_block_timestamp ON oracle_snapshots USING btree (token, snapshot_block_timestamp);

        CREATE TABLE IF NOT EXISTS mev_resist_pool_keys
        (
            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash) PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS incentives_funded
        (
            event_id    int8    NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            owner       NUMERIC NOT NULL,
            token       NUMERIC NOT NULL,
            root        NUMERIC NOT NULL,
            amount_next NUMERIC NOT NULL
        );

        CREATE TABLE IF NOT EXISTS incentives_refunded
        (
            event_id      int8    NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            owner         NUMERIC NOT NULL,
            token         NUMERIC NOT NULL,
            root          NUMERIC NOT NULL,
            refund_amount NUMERIC NOT NULL
        );

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
                 JOIN pool_keys pk ON ek.emitter = pk.extension AND pk.token1 = os.token
        GROUP BY pk.key_hash);

        CREATE MATERIALIZED VIEW IF NOT EXISTS oracle_pool_states_materialized AS
        (
        SELECT pool_key_hash,
               last_snapshot_block_timestamp
        FROM oracle_pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_pool_states_materialized_pool_key_hash ON oracle_pool_states_materialized USING btree (pool_key_hash);

        CREATE OR REPLACE VIEW token_pair_realized_volatility_view AS
        WITH times AS (SELECT blocks.time - INTERVAL '7 days' AS start_time,
                              blocks.time                     AS end_time
                       FROM blocks
                       ORDER BY number DESC
                       LIMIT 1),

             prices AS (SELECT token0,
                               token1,
                               hour,
                               LN(total / k_volume)                                          AS log_price,
                               ROW_NUMBER() OVER (PARTITION BY token0, token1 ORDER BY hour) AS row_no
                        FROM hourly_price_data hpd,
                             times t
                        WHERE hpd.hour BETWEEN t.start_time AND t.end_time
                          AND hpd.k_volume <> 0),

             log_price_changes AS (SELECT token0,
                                          token1,
                                          log_price -
                                          LAG(log_price) OVER (PARTITION BY token0, token1 ORDER BY row_no)             AS price_change,
                                          EXTRACT(HOURS FROM hour - LAG(hour)
                                                                    OVER (PARTITION BY token0, token1 ORDER BY row_no)) AS hours_since_last
                                   FROM prices p
                                   WHERE p.row_no != 1),

             realized_volatility_by_pair AS (SELECT token0,
                                                    token1,
                                                    COUNT(1)                               AS observation_count,
                                                    SQRT(SUM(price_change * price_change)) AS realized_volatility
                                             FROM log_price_changes lpc
                                             GROUP BY token0, token1)

        SELECT token0,
               token1,
               realized_volatility,
               observation_count,
               int4(FLOOR(realized_volatility / LN(1.000001::NUMERIC))) AS volatility_in_ticks
        FROM realized_volatility_by_pair
        WHERE realized_volatility IS NOT NULL;

        CREATE MATERIALIZED VIEW IF NOT EXISTS token_pair_realized_volatility AS
        SELECT * FROM token_pair_realized_volatility_view;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_token_pair_realized_volatility_pair
            ON token_pair_realized_volatility (token0, token1);

        CREATE OR REPLACE VIEW pool_market_depth_view AS
        WITH depth_percentages AS (
          SELECT
            (power(1.3, generate_series(0, 20)) * 0.001)::float AS depth_percent
        ),
        last_swap_per_pair AS (
          SELECT
            token0,
            token1,
            max(event_id) AS last_swap_event_id
        FROM
          swaps s
          JOIN pool_keys pk ON s.pool_key_hash = pk.key_hash
          WHERE
            liquidity_after != 0
          GROUP BY
            token0,
            token1
        ),
        last_swap_time_per_pair AS (
          SELECT
            token0,
            token1,
            b.time
          FROM
            last_swap_per_pair ls
            JOIN event_keys ek ON ls.last_swap_event_id = ek.id
            JOIN blocks b ON ek.block_number = b.number
        ),
        median_ticks AS (
          SELECT
            pk.token0,
            pk.token1,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY tick_after) AS median_tick
          FROM
            swaps s
            JOIN pool_keys pk ON s.pool_key_hash = pk.key_hash
            JOIN event_keys ek ON s.event_id = ek.id
            JOIN blocks b ON b.number = ek.block_number
            JOIN last_swap_time_per_pair lstpp ON pk.token0 = lstpp.token0
              AND pk.token1 = lstpp.token1
          WHERE
            b.time >= lstpp.time - interval '1 hour'
            AND liquidity_after != 0 GROUP BY
              pk.token0,
              pk.token1
        ),
        pool_states AS (
          SELECT
            pk.key_hash,
            pk.token0,
            pk.token1,
            dp.depth_percent,
            floor(ln(1::numeric + dp.depth_percent) / ln(1.000001))::int4 AS depth_in_ticks,
            ceil(log(1::numeric + (pk.fee / 0x10000000000000000::numeric)) / log(1.000001))::int4 AS fee_in_ticks,
            round(mt.median_tick)::int4 AS last_tick
          FROM
            pool_keys pk
            CROSS JOIN depth_percentages dp
            LEFT JOIN median_ticks mt ON pk.token0 = mt.token0
              AND pk.token1 = mt.token1
        ),
        pool_ticks AS (
          SELECT
            pool_key_hash,
            sum(net_liquidity_delta_diff) OVER (PARTITION BY ppptliv.pool_key_hash ORDER BY ppptliv.tick ROWS UNBOUNDED PRECEDING) AS liquidity,
          tick AS tick_start,
          lead(tick) OVER (PARTITION BY ppptliv.pool_key_hash ORDER BY ppptliv.tick) AS tick_end
        FROM
          per_pool_per_tick_liquidity_incremental_view ppptliv
        ),
        depth_liquidity_ranges AS (
          SELECT
            pt.pool_key_hash,
            pt.liquidity,
            ps.depth_percent,
            int4range(ps.last_tick - ps.depth_in_ticks, ps.last_tick - ps.fee_in_ticks) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_below,
            int4range(ps.last_tick + ps.fee_in_ticks, ps.last_tick + ps.depth_in_ticks) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_above
        FROM
          pool_ticks pt
        JOIN pool_states ps ON pt.pool_key_hash = ps.key_hash
        WHERE
          liquidity != 0
          AND ps.fee_in_ticks < ps.depth_in_ticks
        ),
        token_amounts_by_pool AS (
          SELECT
            pool_key_hash,
            depth_percent,
            floor(sum(liquidity * (power(1.0000005::numeric, upper(overlap_range_below)) - power(1.0000005::numeric, lower(overlap_range_below))))) AS amount1,
          floor(sum(liquidity * ((1::numeric / power(1.0000005::numeric, lower(overlap_range_above))) - (1::numeric / power(1.0000005::numeric, upper(overlap_range_above)))))) AS amount0
        FROM
          depth_liquidity_ranges
          WHERE
            NOT isempty(overlap_range_below)
            OR NOT isempty(overlap_range_above)
            GROUP BY
              pool_key_hash,
              depth_percent
        ),
        total_depth AS (
          SELECT
            pool_key_hash,
            depth_percent,
            coalesce(sum(amount0), 0) AS depth0,
            coalesce(sum(amount1), 0) AS depth1
          FROM
            token_amounts_by_pool tabp GROUP BY
              pool_key_hash,
              depth_percent
        )
          SELECT
            td.pool_key_hash,
            td.depth_percent AS depth_percent,
            td.depth0,
            td.depth1
          FROM
            total_depth td;


        CREATE MATERIALIZED VIEW IF NOT EXISTS pool_market_depth AS
        SELECT * FROM pool_market_depth_view;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_market_depth
            ON pool_market_depth (pool_key_hash, depth_percent);
    `);
  }

  public async refreshAnalyticalTables({ since }: { since: Date }) {
    await this.pg.query({
      text: `
                WITH swap_data AS (
                    SELECT swaps.pool_key_hash                                                      AS   key_hash,
                           DATE_TRUNC('hour', blocks.time)                                          AS   hour,
                           (CASE WHEN swaps.delta0 >= 0 THEN pool_keys.token0 ELSE pool_keys.token1 END) token,
                           SUM(CASE WHEN swaps.delta0 >= 0 THEN swaps.delta0 ELSE swaps.delta1 END) AS   volume,
                           SUM(FLOOR(((CASE WHEN delta0 >= 0 THEN swaps.delta0 ELSE swaps.delta1 END) *
                                      pool_keys.fee) /
                                     0x10000000000000000))                                          AS   fees,
                           COUNT(1)                                                                 AS   swap_count
                    FROM swaps
                             JOIN pool_keys ON swaps.pool_key_hash = pool_keys.key_hash
                             JOIN event_keys ON swaps.event_id = event_keys.id
                             JOIN blocks ON event_keys.block_number = blocks.number
                    WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                    GROUP BY hour, swaps.pool_key_hash, token
                ),
                fees_token0 AS (
                    SELECT fa.pool_key_hash                AS key_hash,
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
                    GROUP BY hour, fa.pool_key_hash, token
                ),
                fees_token1 AS (
                    SELECT fa.pool_key_hash                AS key_hash,
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
                    GROUP BY hour, fa.pool_key_hash, token
                ),
                combined_data AS (
                    SELECT key_hash, hour, token, volume, fees, swap_count FROM swap_data
                    UNION ALL
                    SELECT key_hash, hour, token, volume, fees, swap_count FROM fees_token0
                    UNION ALL
                    SELECT key_hash, hour, token, volume, fees, swap_count FROM fees_token1
                )
                INSERT INTO hourly_volume_by_token (key_hash, hour, token, volume, fees, swap_count)
                SELECT key_hash,
                       hour,
                       token,
                       SUM(volume)     AS volume,
                       SUM(fees)       AS fees,
                       SUM(swap_count) AS swap_count
                FROM combined_data
                GROUP BY key_hash, hour, token
                ON CONFLICT (key_hash, hour, token)
                    DO UPDATE SET volume     = excluded.volume,
                                  fees       = excluded.fees,
                                  swap_count = excluded.swap_count;
            `,
      values: [since],
    });

    await this.pg.query({
      text: `
                INSERT INTO hourly_revenue_by_token
                    (WITH rev0 AS (SELECT pu.pool_key_hash                AS key_hash,
                                          DATE_TRUNC('hour', blocks.time) AS hour,
                                          pk.token0                          token,
                                          SUM(CEIL((-delta0 * 0x10000000000000000::NUMERIC) /
                                                   (0x10000000000000000::NUMERIC - pk.fee)) +
                                              delta0)                     AS revenue
                                   FROM position_updates pu
                                            JOIN pool_keys pk ON pu.pool_key_hash = pk.key_hash
                                            JOIN event_keys ek ON pu.event_id = ek.id
                                            JOIN blocks ON ek.block_number = blocks.number
                                   WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                                     AND pu.delta0 < 0
                                     AND pk.fee != 0
                                   GROUP BY hour, pu.pool_key_hash, token),
                          rev1 AS (SELECT pu.pool_key_hash                AS key_hash,
                                          DATE_TRUNC('hour', blocks.time) AS hour,
                                          pk.token1                          token,
                                          SUM(CEIL((-delta1 * 0x10000000000000000::NUMERIC) /
                                                   (0x10000000000000000::NUMERIC - pk.fee)) +
                                              delta1)                     AS revenue
                                   FROM position_updates pu
                                            JOIN pool_keys pk ON pu.pool_key_hash = pk.key_hash
                                            JOIN event_keys ek ON pu.event_id = ek.id
                                            JOIN blocks ON ek.block_number = blocks.number
                                   WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                                     AND pu.delta1 < 0
                                     AND pk.fee != 0
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
                WITH total_swaps_per_block_pair AS (SELECT ek.block_number,
                                                           pk.token0   AS token0,
                                                           pk.token1   AS token1,
                                                           SUM(delta0) AS total_delta0,
                                                           SUM(delta1) AS total_delta1,
                                                           COUNT(1)    AS swap_count
                                                    FROM swaps s
                                                             JOIN event_keys ek ON s.event_id = ek.id
                                                             JOIN pool_keys pk ON s.pool_key_hash = pk.key_hash
                                                    GROUP BY block_number, pk.token0, pk.token1)
                INSERT
                INTO hourly_price_data
                    (SELECT token0,
                            token1,
                            DATE_TRUNC('hour', b.time)            AS hour,
                            SUM(ABS(total_delta0 * total_delta1)) AS k_volume,
                            SUM(total_delta1 * total_delta1)      AS total,
                            SUM(swap_count)                       AS swap_count
                     FROM total_swaps_per_block_pair tspt
                              JOIN blocks b ON tspt.block_number = b.number
                     WHERE total_delta0 != 0
                       AND total_delta1 != 0
                       AND DATE_TRUNC('hour', b.time) >= DATE_TRUNC('hour', $1::timestamptz)
                     GROUP BY token0, token1, hour)
                ON CONFLICT (token0, token1, hour)
                    DO UPDATE SET k_volume   = excluded.k_volume,
                                  total      = excluded.total,
                                  swap_count = excluded.swap_count;
            `,
      values: [since],
    });

    await this.pg.query({
      text: `
                INSERT INTO hourly_twap_data
                    (WITH swap_times AS (
                        SELECT s.pool_key_hash,
                               pk.token0,
                               pk.token1,
                               date_bin(INTERVAL '1 hour', b.time, '2000-01-01 00:00:00'::TIMESTAMP WITHOUT TIME ZONE) AS hour,
                               b.time,
                               s.tick_after,
                               s.liquidity_after,
                               LAG(b.time) OVER (PARTITION BY s.pool_key_hash, 
                                   date_bin(INTERVAL '1 hour', b.time, '2000-01-01 00:00:00'::TIMESTAMP WITHOUT TIME ZONE) 
                                   ORDER BY b.time) AS prev_time,
                               LAG(s.tick_after) OVER (PARTITION BY s.pool_key_hash, 
                                   date_bin(INTERVAL '1 hour', b.time, '2000-01-01 00:00:00'::TIMESTAMP WITHOUT TIME ZONE) 
                                   ORDER BY b.time) AS prev_tick,
                               LAG(s.liquidity_after) OVER (PARTITION BY s.pool_key_hash, 
                                   date_bin(INTERVAL '1 hour', b.time, '2000-01-01 00:00:00'::TIMESTAMP WITHOUT TIME ZONE) 
                                   ORDER BY b.time) AS prev_liquidity
                        FROM swaps s
                                 JOIN event_keys ek ON s.event_id = ek.id
                                 JOIN blocks b ON ek.block_number = b.number
                                 JOIN pool_keys pk ON s.pool_key_hash = pk.key_hash
                        WHERE DATE_TRUNC('hour', b.time) >= DATE_TRUNC('hour', $1::timestamptz)
                          AND delta0 != 0
                          AND delta1 != 0
                    ),
                    tick_liquidity_durations AS (
                        SELECT pool_key_hash,
                               token0,
                               token1,
                               hour,
                               tick_after,
                               liquidity_after,
                               CASE 
                                   WHEN prev_time IS NULL THEN 
                                       EXTRACT(EPOCH FROM (time - hour))
                                   ELSE 
                                       EXTRACT(EPOCH FROM (time - prev_time))
                               END AS duration_seconds,
                               CASE 
                                   WHEN prev_tick IS NULL THEN tick_after
                                   ELSE prev_tick
                               END AS effective_tick,
                               CASE 
                                   WHEN prev_liquidity IS NULL THEN liquidity_after
                                   ELSE prev_liquidity
                               END AS effective_liquidity
                        FROM swap_times
                        UNION ALL
                        SELECT pool_key_hash,
                               token0,
                               token1,
                               hour,
                               tick_after,
                               liquidity_after,
                               EXTRACT(EPOCH FROM ((hour + INTERVAL '1 hour') - time)) AS duration_seconds,
                               tick_after AS effective_tick,
                               liquidity_after AS effective_liquidity
                        FROM (
                            SELECT DISTINCT ON (pool_key_hash, hour) 
                                   pool_key_hash, token0, token1, hour, time, tick_after, liquidity_after
                            FROM swap_times
                            ORDER BY pool_key_hash, hour, time DESC
                        ) last_swaps
                    ),
                    pool_twaps AS (
                        SELECT pool_key_hash,
                               token0,
                               token1,
                               hour,
                               SUM(effective_tick * duration_seconds * effective_liquidity) AS tick_liquidity_seconds,
                               SUM(duration_seconds * effective_liquidity) AS liquidity_seconds,
                               SUM(duration_seconds) AS total_time_seconds,
                               COUNT(*) / 2 AS swap_count
                        FROM tick_liquidity_durations
                        WHERE duration_seconds > 0 AND effective_liquidity > 0
                        GROUP BY pool_key_hash, token0, token1, hour
                    ),
                    aggregated_twaps AS (
                        SELECT token0,
                               token1,
                               hour,
                               SUM(tick_liquidity_seconds) / NULLIF(SUM(liquidity_seconds), 0) AS liquidity_weighted_tick,
                               SUM(liquidity_seconds) AS total_liquidity_seconds,
                               SUM(total_time_seconds) AS total_time_seconds,
                               SUM(swap_count) AS swap_count,
                               COUNT(DISTINCT pool_key_hash) AS pool_count
                        FROM pool_twaps
                        GROUP BY token0, token1, hour
                    )
                    SELECT token0,
                           token1,
                           hour,
                           liquidity_weighted_tick,
                           total_liquidity_seconds,
                           total_time_seconds,
                           swap_count,
                           pool_count
                    FROM aggregated_twaps
                    WHERE liquidity_weighted_tick IS NOT NULL)
                ON CONFLICT (token0, token1, hour)
                    DO UPDATE SET liquidity_weighted_tick = excluded.liquidity_weighted_tick,
                                  total_liquidity_seconds = excluded.total_liquidity_seconds,
                                  total_time_seconds = excluded.total_time_seconds,
                                  swap_count = excluded.swap_count,
                                  pool_count = excluded.pool_count;
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
                                             ORDER BY id
                                             LIMIT 1),
                          grouped_pool_key_hash_deltas AS (SELECT pool_key_hash,
                                                                  DATE_TRUNC('hour', blocks.time) AS hour,
                                                                  SUM(delta0)                     AS delta0,
                                                                  SUM(delta1)                     AS delta1
                                                           FROM swaps
                                                                    JOIN event_keys ON swaps.event_id = event_keys.id
                                                                    JOIN blocks ON event_keys.block_number = blocks.number
                                                           WHERE event_id >= (SELECT id FROM first_event_id)
                                                           GROUP BY pool_key_hash, hour

                                                           UNION ALL

                                                           SELECT pool_key_hash,
                                                                  DATE_TRUNC('hour', blocks.time) AS hour,
                                                                  SUM(CASE
                                                                          WHEN liquidity_delta < 0 THEN CEIL(
                                                                                  (delta0 * 0x10000000000000000::NUMERIC) /
                                                                                  (0x10000000000000000::NUMERIC - pk.fee))
                                                                          ELSE delta0 END)        AS delta0,
                                                                  SUM(CASE
                                                                          WHEN liquidity_delta < 0 THEN CEIL(
                                                                                  (delta1 * 0x10000000000000000::NUMERIC) /
                                                                                  (0x10000000000000000::NUMERIC - pk.fee))
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
                                                                  SUM(-delta0)                    AS delta0,
                                                                  SUM(-delta1)                    AS delta1
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
                                                           GROUP BY pool_key_hash, hour),
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
      REFRESH MATERIALIZED VIEW CONCURRENTLY token_pair_realized_volatility;
      REFRESH MATERIALIZED VIEW CONCURRENTLY pool_market_depth;
    `);
  }

  public async refreshOperationalMaterializedView() {
    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY twamm_pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY twamm_sale_rate_deltas_materialized;
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
    poolId: `0x${string}`
  ): Promise<`0x${string}`> {
    const keyHash = toKeyHash(coreAddress, poolId);

    const { fee, tickSpacing, extension } = parsePoolKeyConfig(poolKey.config);

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
    key: EventKey
  ) {
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

  public async insertOrdersTransferEvent(
    transfer: OrderTransfer,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO order_transfers
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
    key: EventKey
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

        event.poolId,

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
    key: EventKey
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

        event.poolId,

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
    key: EventKey
  ): Promise<`0x${string}`> {
    const poolKeyHash = await this.insertPoolKey(
      key.emitter,
      event.poolKey,
      event.poolId
    );

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
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8)
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

    return poolKeyHash;
  }

  public async insertMEVResistPoolKey(poolKeyHash: `0x${string}`) {
    await this.pg.query({
      text: `
          INSERT
          INTO mev_resist_pool_keys (pool_key_hash)
          VALUES ($1::numeric)
          ON CONFLICT DO NOTHING;
      `,
      values: [poolKeyHash],
    });
  }

  public async insertProtocolFeesWithdrawn(
    event: CoreProtocolFeesWithdrawn,
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
                        (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $6),
                        $7, $8);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.poolId,

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

  public async insertTWAMMOrderUpdatedEvent(
    event: TwammOrderUpdated,
    key: EventKey
  ) {
    const { orderKey } = event;

    const [token0, token1, sale_rate_delta0, sale_rate_delta1] =
      BigInt(orderKey.sellToken) > BigInt(orderKey.buyToken)
        ? [orderKey.buyToken, orderKey.sellToken, 0, event.saleRateDelta]
        : [orderKey.sellToken, orderKey.buyToken, event.saleRateDelta, 0];

    const poolId = toPoolId({
      token0,
      token1,
      config: toPoolConfig({
        fee: orderKey.fee,
        tickSpacing: 0,
        extension: key.emitter,
      }),
    });

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys
                        (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO twamm_order_updates
                (event_id,
                 key_hash,
                 owner,
                 salt,
                 sale_rate_delta0,
                 sale_rate_delta1,
                 start_time,
                 end_time)
                VALUES ((SELECT id FROM inserted_event),
                        (SELECT key_hash
                         FROM pool_keys
                         WHERE core_address = (SELECT ek.emitter
                                               FROM extension_registrations er
                                                        JOIN event_keys ek ON er.event_id = ek.id
                                               WHERE er.extension = $5)
                           AND pool_id = $6), $7, $8, $9, $10, $11, $12);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        poolId,

        BigInt(event.owner),
        BigInt(event.salt),
        sale_rate_delta0,
        sale_rate_delta1,
        new Date(Number(orderKey.startTime * 1000n)),
        new Date(Number(orderKey.endTime * 1000n)),
      ],
    });
  }

  public async insertTWAMMOrderProceedsWithdrawnEvent(
    event: TwammOrderProceedsWithdrawn,
    key: EventKey
  ) {
    const { orderKey } = event;

    const [token0, token1, amount0, amount1] =
      BigInt(orderKey.sellToken) > BigInt(orderKey.buyToken)
        ? [orderKey.buyToken, orderKey.sellToken, 0, event.amount]
        : [orderKey.sellToken, orderKey.buyToken, event.amount, 0];

    const poolId = toPoolId({
      token0,
      token1,
      config: toPoolConfig({
        fee: orderKey.fee,
        tickSpacing: 0,
        extension: key.emitter,
      }),
    });

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO twamm_proceeds_withdrawals
                (event_id, key_hash, owner, salt, amount0, amount1, start_time, end_time)
                VALUES ((SELECT id FROM inserted_event),
                        (SELECT key_hash
                         FROM pool_keys
                         WHERE core_address = (SELECT ek.emitter
                                               FROM extension_registrations er
                                                        JOIN event_keys ek ON er.event_id = ek.id
                                               WHERE er.extension = $5)
                           AND pool_id = $6), $7, $8, $9, $10, $11, $12);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        poolId,

        BigInt(event.owner),
        BigInt(event.salt),
        amount0,
        amount1,
        new Date(Number(orderKey.startTime * 1000n)),
        new Date(Number(orderKey.endTime * 1000n)),
      ],
    });
  }

  public async insertTWAMMVirtualOrdersExecutedEvent(
    event: TwammVirtualOrdersExecutedEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys
                        (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO twamm_virtual_order_executions
                    (event_id, key_hash, token0_sale_rate, token1_sale_rate)
                VALUES ((SELECT id FROM inserted_event),
                        (SELECT key_hash
                         FROM pool_keys
                         WHERE core_address = (SELECT ek.emitter
                                               FROM extension_registrations er
                                                        JOIN event_keys ek ON er.event_id = ek.id
                                               WHERE er.extension = $5)
                           AND pool_id = $6), $7, $8);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.poolId,
        event.saleRateToken0,
        event.saleRateToken1,
      ],
    });
  }

  async insertOracleSnapshotEvent(parsed: OracleEvent, key: EventKey) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO oracle_snapshots
                (event_id, token, snapshot_block_timestamp, snapshot_tick_cumulative,
                 snapshot_seconds_per_liquidity_cumulative)
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

  async insertIncentivesRefundedEvent(
    key: EventKey,
    parsed: IncentivesRefunded
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO incentives_refunded
                    (event_id, owner, token, root, refund_amount)
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8, $9)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.key.owner,
        parsed.key.token,
        parsed.key.root,
        parsed.refundAmount,
      ],
    });
  }

  async insertIncentivesFundedEvent(key: EventKey, parsed: IncentivesFunded) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id)
                INSERT
                INTO incentives_funded
                    (event_id, owner, token, root, amount_next)
                VALUES ((SELECT id FROM inserted_event), $6, $7, $8, $9)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.key.owner,
        parsed.key.token,
        parsed.key.root,
        parsed.amountNext,
      ],
    });
  }
}
