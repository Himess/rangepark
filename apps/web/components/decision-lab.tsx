"use client";
import { useState } from "react";
import { ArrowRight, Download, FlaskConical, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
type Result = {
  mode: string;
  decision: {
    action: string;
    reasons: string[];
    supplyAmount: string;
    expectedYield: string;
    requiredBenefit: string;
    breakEvenSeconds: string | null;
    policyHash: string;
    expiresAt: number;
  };
  plan: null | {
    planHash: string;
    steps: {
      id: string;
      contractAddress: string;
      functionName: string;
      calldata: string;
    }[];
  };
};
const cases = [
  ["normal", "Normal parking"],
  ["stale", "Stale chain data"],
  ["paused", "Paused lending reserve"],
  ["insufficient-history", "Not enough observations"],
  ["price-recovered", "Price back in range"],
];
const money = (v: string) =>
  `$${(Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const reason = (v: string) =>
  v
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
export function DecisionLab() {
  const [form, setForm] = useState({
      capital: "10000",
      cost: "2",
      foregone: "1",
      apr: 5,
      days: 7,
      scenario: "normal",
    }),
    [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  function update(key: string, value: string | number) {
    setForm((v) => ({ ...v, [key]: value }));
    setDirty(true);
  }
  async function evaluate() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await response.json()) as Result & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "Could not evaluate scenario");
      if (body.mode !== "SYNTHETIC_SIMULATION" || !body.decision)
        throw new Error("Invalid scenario response");
      setResult(body);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not evaluate scenario");
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!result) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    link.download = "rangepark-synthetic-decision.json";
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <>
      <div className="status-strip">
        <div>
          <FlaskConical size={16} />
          <strong>Synthetic decision lab</strong>
          <span>No RPC calls. No transactions.</span>
        </div>
        <span>Same policy engine as the CLI</span>
      </div>
      <div className="console-grid">
        <section className="panel lab-form">
          <p className="eyebrow">TEST THE ECONOMICS</p>
          <h2>When is parking worth it?</h2>
          <p className="muted">
            Change the assumptions. The policy must still pass every gate.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void evaluate();
            }}
          >
            <div className="form-grid">
              {[
                ["capital", "Capital · USDC"],
                ["cost", "Round-trip cost · USDC"],
                ["foregone", "Foregone LP fees · USDC"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    required
                    inputMode="decimal"
                    value={form[key as "capital" | "cost" | "foregone"]}
                    onChange={(e) => update(key, e.target.value)}
                  />
                </label>
              ))}
              <label>
                Supply APR · %
                <input
                  type="number"
                  min="0"
                  max="50"
                  step="0.01"
                  required
                  value={form.apr}
                  onChange={(e) => update("apr", Number(e.target.value))}
                />
              </label>
              <label>
                Assumed parking · days
                <input
                  type="number"
                  min="1"
                  max="90"
                  required
                  value={form.days}
                  onChange={(e) => update("days", Number(e.target.value))}
                />
              </label>
              <label htmlFor="scenario-condition">
                Condition
                <Select
                  value={form.scenario}
                  onValueChange={(v) => {
                    if (v) update("scenario", v);
                  }}
                >
                  <SelectTrigger id="scenario-condition" className="scenario-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cases.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <div className="policy-note">
              <ShieldCheck size={18} />
              <span>
                20% yield haircut · 3× cost coverage · 0.30% slippage budget
              </span>
            </div>
            <Button type="submit" className="primary-action" disabled={busy}>
              {busy ? "Evaluating…" : "Evaluate scenario"}
              <ArrowRight size={17} />
            </Button>
          </form>
          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
        </section>
        <aside className="decision-panel" aria-live="polite">
          <div className="decision-top">
            <span className="eyebrow">POLICY VERDICT</span>
            <FlaskConical size={23} />
          </div>
          <span className="hold-label">
            {result?.decision.action ?? "READY"}
          </span>
          <h2>
            {result
              ? result.decision.action === "PARK"
                ? "The numbers clear the bar."
                : "Staying put is a decision."
              : "Every move needs a reason."}
          </h2>
          <p>
            {dirty
              ? "Inputs changed. Evaluate again for an updated result."
              : result
                ? "This is a scenario result, not a recommendation or permission to move funds."
                : "Evaluate a scenario to see the expected benefit, rejection reasons and exact draft plan."}
          </p>
          {result ? (
            <>
              <div className="lab-metric">
                <span>Haircut yield over horizon</span>
                <strong>{money(result.decision.expectedYield)}</strong>
              </div>
              <div className="lab-metric">
                <span>Required benefit</span>
                <strong>{money(result.decision.requiredBenefit)}</strong>
              </div>
              <div className="lab-metric">
                <span>Estimated break-even</span>
                <strong>
                  {result.decision.breakEvenSeconds === null
                    ? "Not reached"
                    : `${(Number(result.decision.breakEvenSeconds) / 86400).toFixed(1)} days`}
                </strong>
              </div>
              <div className="decision-bottom">
                {result.decision.reasons.map((r) => (
                  <p className="reason" key={r}>
                    {reason(r)}
                  </p>
                ))}
              </div>
            </>
          ) : null}
        </aside>
      </div>
      {result ? (
        <section className="panel receipt-panel">
          <div className="section-label">
            <h2>
              {result.plan ? "Review-only execution plan" : "Decision receipt"}
            </h2>
            <Button variant="outline" onClick={download}>
              <Download size={15} /> Download JSON
            </Button>
          </div>
          <p className="muted">
            {result.plan
              ? "Parameters are frozen. No KeeperHub simulation or execution has been run."
              : "The policy refused to create an execution plan for this scenario."}
          </p>
          {result.plan ? (
            <>
              <div className="plan-steps">
                {result.plan.steps.map((step, i) => (
                  <div key={step.id}>
                    <span className="step-number">0{i + 1}</span>
                    <div>
                      <strong>
                        {step.id === "release"
                          ? "Decrease + collect"
                          : step.id === "approve"
                            ? "Approve exact amount"
                            : "Supply to Aave"}
                      </strong>
                      <p>{step.functionName}</p>
                      <code>{step.contractAddress}</code>
                    </div>
                    <span className="pill">DRAFT</span>
                  </div>
                ))}
              </div>
              <details>
                <summary>Plan hash and calldata</summary>
                <pre>{JSON.stringify(result.plan, null, 2)}</pre>
              </details>
            </>
          ) : (
            <div className="empty-note">
              No transaction steps. The capital stays where it is.
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
