import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const positions = sqliteTable('positions', {
  tokenId: text('token_id').primaryKey(),
  snapshot: text('snapshot').notNull(),
  observation: text('observation').notNull(),
  blockNumber: integer('block_number').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const hostedReturnMonitor = sqliteTable('hosted_return_monitor', {
  id: text('id').primaryKey(),
  leaseOwner: text('lease_owner').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  slot: integer('slot').notNull(),
  observation: text('observation'),
  report: text('report'),
  recent: text('recent').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull().default(0),
});
