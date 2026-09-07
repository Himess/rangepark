import { env } from "cloudflare:workers";
function db() {
  if (!env.DB) throw new Error("Position storage unavailable");
  return env.DB;
}
export type StoredPosition = {
  token_id: string;
  snapshot: string;
  observation: string;
  block_number: number;
  updated_at: number;
};
export async function getPosition(id: string) {
  return db()
    .prepare("SELECT * FROM positions WHERE token_id=?")
    .bind(id)
    .first<StoredPosition>();
}
export async function listPositions() {
  return (
    await db()
      .prepare(
        "SELECT token_id,block_number,updated_at FROM positions ORDER BY updated_at DESC LIMIT 20",
      )
      .all()
  ).results;
}
export async function savePosition(
  id: string,
  snapshot: string,
  observation: string,
  block: number,
) {
  await db()
    .prepare(
      "INSERT INTO positions(token_id,snapshot,observation,block_number,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET snapshot=excluded.snapshot,observation=excluded.observation,block_number=excluded.block_number,updated_at=excluded.updated_at WHERE excluded.block_number>=positions.block_number",
    )
    .bind(id, snapshot, observation, block, Date.now())
    .run();
}
