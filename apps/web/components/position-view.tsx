"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  Radio,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import initial from "@/lib/initial-position.json";

type Snapshot = typeof initial & { readAt?: number; supported?: boolean };
const display = (raw: string, decimals: number, digits = 4) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: object;
      execute: (input: unknown) => Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};

export function PositionView() {
  const [data, setData] = useState<Snapshot>(initial),
    [id, setId] = useState("5950133"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [source, setSource] = useState("Recorded snapshot"),
    [watch, setWatch] = useState(false);
  const [saved, setSaved] = useState<{ token_id: string }[]>([]);
  const loading = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void fetch("/api/positions")
      .then((r) => r.json())
      .then((body) => {
        const r = body as { positions?: { token_id: string }[] };
        if (alive.current && Array.isArray(r.positions)) setSaved(r.positions);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, []);
  const inspect = useCallback(async (tokenId: string) => {
    if (!/^[0-9]{1,20}$/.test(tokenId))
      throw new Error("Enter a numeric NFT token ID.");
    if (loading.current) throw new Error("A refresh is already in progress.");
    loading.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
        signal: AbortSignal.timeout(45000),
      });
      const result = (await response.json()) as Snapshot & {
        error?: string;
        cached?: boolean;
        side: string;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Could not refresh position");
      if (!result.position || !Array.isArray(result.aaveMarkets))
        throw new Error("Invalid position response");
      if (alive.current) {
        setData(result);
        setId(tokenId);
        setSource(
          result.cached ? "Saved read · refreshed recently" : "Read from Base",
        );
        setSaved((v) =>
          [
            { token_id: tokenId },
            ...v.filter((x) => x.token_id !== tokenId),
          ].slice(0, 20),
        );
      }
      return {
        tokenId,
        block: result.position.block.number,
        side: result.side,
        persistenceSeconds:
          result.observation.lastAt - result.observation.since,
        mode: "READ_ONLY",
      };
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "Refresh failed");
      throw cause;
    } finally {
      loading.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => {
      void inspect(data.position.tokenId).catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, [watch, data.position.tokenId, inspect]);
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: "inspect_rangepark_position",
            title: "Inspect Base LP position",
            description:
              "Refresh a Base Uniswap V3 NFT, save its public observation and update the visible position. Does not authorize or execute transactions.",
            inputSchema: {
              type: "object",
              properties: {
                tokenId: { type: "string", pattern: "^[0-9]{1,20}$" },
              },
              required: ["tokenId"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            async execute(input) {
              if (
                !input ||
                typeof input !== "object" ||
                !("tokenId" in input) ||
                typeof input.tokenId !== "string"
              )
                throw new Error("tokenId required");
              return inspect(input.tokenId);
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => lifecycle.abort();
  }, [inspect]);
  const p = data.position,
    inRange = p.currentTick >= p.tickLower && p.currentTick < p.tickUpper;
  const marker =
    12 +
    76 *
      Math.min(
        1,
        Math.max(
          0,
          (p.currentTick - p.tickLower) / (p.tickUpper - p.tickLower),
        ),
      );
  const elapsed = Math.max(0, data.observation.lastAt - data.observation.since);
  const supported =
    p.token0.symbol === "WETH" &&
    p.token1.symbol === "USDC" &&
    data.supported !== false;
  return (
    <>
      <section className="status-strip">
        <div>
          <Radio size={16} />
          <strong>{source}</strong>
          <span>Block {Number(p.block.number).toLocaleString("en-US")}</span>
          <a
            href={`https://basescan.org/block/${p.block.number}`}
            target="_blank"
            rel="noreferrer"
            aria-label="View source block"
          >
            <ArrowUpRight size={14} />
          </a>
        </div>
        <span>
          {new Date(p.block.timestamp * 1000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19)}{" "}
          UTC
        </span>
      </section>
      {error ? (
        <p role="alert" className="error-message">
          {error}
        </p>
      ) : null}
      <div className="console-grid">
        <section className="panel position-panel" aria-busy={busy}>
          <div className="panel-head">
            <div className="token-pair">
              <span className="coin eth">Ξ</span>
              <span className="coin usdc">$</span>
              <div>
                <h2>
                  {p.token0.symbol} / {p.token1.symbol}
                </h2>
                <span>Uniswap V3 · {(p.fee / 10000).toFixed(2)}% pool fee</span>
              </div>
            </div>
            <span className={`pill ${inRange ? "good" : "warning"}`}>
              <i />
              {p.liquidity === "0"
                ? "Empty position"
                : inRange
                  ? "In range"
                  : "Out of range"}
            </span>
          </div>
          <div className="position-meta">
            <span>
              POSITION <strong>#{p.tokenId}</strong>
            </span>
            <a
              href={`https://basescan.org/token/0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1?a=${p.tokenId}`}
              target="_blank"
              rel="noreferrer"
            >
              View NFT <ArrowUpRight size={14} />
            </a>
          </div>
          <div className="balance-grid">
            <div>
              <p>{p.token0.symbol} principal</p>
              <strong>
                {display(p.principal0, p.token0.decimals)}{" "}
                <small>{p.token0.symbol}</small>
              </strong>
            </div>
            <div>
              <p>{p.token1.symbol} principal</p>
              <strong>
                {display(p.principal1, p.token1.decimals, 2)}{" "}
                <small>{p.token1.symbol}</small>
              </strong>
            </div>
          </div>
          <div className="range-section">
            <div className="section-label">
              <span>POSITION RANGE</span>
              <span>
                Current tick <b>{p.currentTick.toLocaleString("en-US")}</b>
              </span>
            </div>
            <figure
              className="range-track"
              aria-label={`Tick ${p.currentTick}; range ${p.tickLower} to ${p.tickUpper}, upper exclusive`}
            >
              <div className="range-fill" />
              <div className="tick-marker" style={{ left: `${marker}%` }}>
                <span>{inRange ? "Current price" : "Outside range"}</span>
              </div>
            </figure>
            <div className="range-labels">
              <span>
                {p.tickLower.toLocaleString("en-US")}
                <small>Lower tick</small>
              </span>
              <span>
                {p.tickUpper.toLocaleString("en-US")}
                <small>Upper tick · exclusive</small>
              </span>
            </div>
            <p className="range-note">
              <CircleCheck size={15} />
              {inRange
                ? "Within the range. Liquidity can earn swap fees."
                : "Outside the range. This liquidity is not earning swap fees."}
            </p>
          </div>
          <form
            className="inspector"
            onSubmit={(e) => {
              e.preventDefault();
              void inspect(id).catch(() => {});
            }}
          >
            <label htmlFor="position-id">Inspect any Base Uniswap V3 NFT</label>
            <div>
              <input
                id="position-id"
                inputMode="numeric"
                pattern="[0-9]{1,20}"
                required
                value={id}
                onChange={(e) => setId(e.target.value)}
                aria-describedby="inspect-help"
              />
              <Button
                type="submit"
                variant="outline"
                className="secondary-action"
                disabled={busy}
              >
                <RefreshCw size={15} className={busy ? "spin" : ""} />
                {busy ? "Reading Base…" : "Refresh position"}
              </Button>
            </div>
            <p id="inspect-help">
              Public reads only. NFT ownership does not grant this site
              execution rights.
            </p>
          </form>
          <div className="watch-toggle">
            <Switch id="watch" checked={watch} onCheckedChange={setWatch} />
            <label htmlFor="watch">
              Observe every minute while this view is open
            </label>
          </div>
          {saved.length > 0 ? (
            <div className="saved-positions">
              <span>Saved reads</span>
              {saved.slice(0, 5).map((s) => (
                <Button
                  size="sm"
                  variant="ghost"
                  key={s.token_id}
                  disabled={busy}
                  onClick={() => {
                    void inspect(s.token_id).catch(() => {});
                  }}
                >
                  #{s.token_id}
                </Button>
              ))}
            </div>
          ) : null}
        </section>
        <aside className="decision-panel">
          <div className="decision-top">
            <span className="eyebrow">CURRENT POSTURE</span>
            <ShieldCheck size={23} />
          </div>
          <span className="hold-label">{inRange ? "HOLD" : "WATCH"}</span>
          <h2>
            {inRange
              ? "Let the position do its job."
              : "Fee-idle. Worth a closer look."}
          </h2>
          <p>
            {!supported
              ? "This pair is readable. Automated parking is limited to WETH/USDC."
              : inRange
                ? "The observed price is in range. There is no out-of-range parking trigger."
                : "Parking needs a sustained exit and a positive benefit after costs. A single snapshot is not enough."}
          </p>
          <div className="decision-check">
            <CircleCheck size={17} />
            <span>5-minute TWAP: {p.twapTick ?? "unavailable"}</span>
          </div>
          <div className="decision-check">
            <CircleCheck size={17} />
            <span>Observed state: {Math.floor(elapsed / 60)} minutes</span>
          </div>
          <div className="decision-check">
            <CircleCheck size={17} />
            <span>Live policy: not evaluated</span>
          </div>
          <div className="decision-bottom">
            <span>EXECUTION LAYER</span>
            <strong>
              KeeperHub <ArrowUpRight size={17} />
            </strong>
            <p>Connection not configured · funds untouched</p>
          </div>
        </aside>
      </div>
      <section className="panel venue-panel">
        <div className="section-label">
          <h2>Where capital can wait</h2>
          <span>Supply APR at source block · excludes incentives</span>
        </div>
        {data.aaveMarkets.length ? (
          data.aaveMarkets.map((m) => (
            <div className="venue-row" key={m.asset.address}>
              <div className="venue-icon">A</div>
              <div>
                <strong>Aave V3</strong>
                <p>{m.asset.symbol} reserve</p>
              </div>
              <div className="venue-rate">
                <strong>
                  {(Number(m.supplyAprRay) / 1e25).toFixed(2)}
                  <small>%</small>
                </strong>
                <span>APR</span>
              </div>
              <span
                className={`pill ${m.active && !m.frozen && !m.paused ? "good" : "warning"}`}
              >
                {m.active && !m.frozen && !m.paused
                  ? "Supply open"
                  : "Supply unavailable"}
              </span>
              <a
                href={`https://basescan.org/address/${m.aToken}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`View ${m.asset.symbol} reserve`}
              >
                <ArrowUpRight size={18} />
              </a>
            </div>
          ))
        ) : (
          <p className="empty-note">
            No allowlisted lending markets for this pair.
          </p>
        )}
      </section>
    </>
  );
}
