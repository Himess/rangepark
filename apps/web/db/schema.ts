import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const positions = sqliteTable("positions", {
  tokenId: text("token_id").primaryKey(),
  snapshot: text("snapshot").notNull(),
  observation: text("observation").notNull(),
  blockNumber: integer("block_number").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
