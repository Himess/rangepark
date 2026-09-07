import { z } from "zod";
import { isAddressEqual } from "viem";
import { response, revive, sameOrigin } from "@/lib/api";
import { getPosition, listPositions, savePosition } from "@/lib/store";
import {
  baseClient,
  readBlock,
  verifyBlock,
} from "@/lib/rangepark/chain/client";
import { readPosition } from "@/lib/rangepark/chain/uniswap";
import { readAaveMarket } from "@/lib/rangepark/chain/aave";
import { BASE } from "@/lib/rangepark/config/base";
import { observePosition, rangeSide } from "@/lib/rangepark/core/range";
import { defaultPolicy } from "@/lib/rangepark/core/decision";
import { json } from "@/lib/rangepark/core/serialization";
import type { Observation } from "@/lib/rangepark/core/models";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return response({ positions: await listPositions() });
    if (!/^[0-9]{1,20}$/.test(id))
      return response({ error: "Invalid NFT ID" }, 400);
    const saved = await getPosition(id);
    return saved
      ? response(JSON.parse(saved.snapshot))
      : response({ error: "No saved position" }, 404);
  } catch {
    return response(
      { error: "Position history is temporarily unavailable" },
      503,
    );
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (Number(request.headers.get("content-length") ?? 0) > 2000)
      return response({ error: "Request too large" }, 413);
    const { tokenId } = z
      .object({ tokenId: z.string().regex(/^[0-9]{1,20}$/) })
      .strict()
      .parse(await request.json());
    const previous = await getPosition(tokenId);
    if (previous && Date.now() - previous.updated_at < 15000)
      return response({ ...JSON.parse(previous.snapshot), cached: true });
    const client = baseClient();
    const block = await readBlock(client);
    const position = await readPosition(client, BigInt(tokenId), block);
    const supported =
      isAddressEqual(position.token0.address, BASE.weth) &&
      isAddressEqual(position.token1.address, BASE.usdc);
    const markets = supported
      ? await Promise.all([
          readAaveMarket(client, position.token0, block),
          readAaveMarket(client, position.token1, block),
        ])
      : [];
    await verifyBlock(client, block);
    const observation = observePosition(
      position,
      previous ? revive<Observation>(previous.observation) : null,
      defaultPolicy.maxObservationGapSeconds,
    );
    const payload = {
      mode: "LIVE_READ_ONLY",
      position,
      aaveMarkets: markets,
      observation,
      supported,
      side: rangeSide(
        position.currentTick,
        position.tickLower,
        position.tickUpper,
      ),
      readAt: Date.now(),
      decision: "NOT_EVALUATED",
    };
    await savePosition(
      tokenId,
      json(payload),
      json(observation),
      Number(block.number),
    );
    return response(payload);
  } catch (error) {
    if (error instanceof z.ZodError)
      return response(
        { error: "Enter a numeric Uniswap V3 NFT token ID" },
        400,
      );
    return response(
      {
        error:
          "Could not refresh this NFT. Check the ID or retry when the Base RPC is available.",
      },
      502,
    );
  }
}
