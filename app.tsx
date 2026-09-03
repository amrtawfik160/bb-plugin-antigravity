// bb-plugin-antigravity — settings panel.
//
// One job: show whether the Antigravity ACP provider is wired up, and let the
// user fix it. Everything it renders comes from the same `readStatus` the CLI
// prints, so the two surfaces cannot disagree.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface StatusShape {
  providerId: string;
  configPath: string;
  enabled: boolean;
  transport: string;
  agyMissing: boolean;
  adapterMissing: boolean;
  adapterPath?: string;
  pickerRegistered?: boolean;
  drift?: string;
  agy?: {
    path: string;
    version?: string;
    authState: "ok" | "failed" | "unknown";
    modelCount?: number;
    error?: string;
  };
}

function Row({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: "normal" | "good" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-success"
      : tone === "bad"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`${toneClass} truncate font-mono text-xs`} title={value}>
        {value}
      </span>
    </div>
  );
}

function AntigravityPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<StatusShape | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void rpc.call("status").then((next) => setStatus(next as StatusShape));
  }, [rpc]);

  useEffect(refresh, [refresh]);

  const apply = useCallback(
    (action: "enable" | "disable") => {
      setBusy(true);
      setMessage(null);
      void rpc
        .call(action)
        .then((result) => {
          setMessage(result.message);
          if (result.status) setStatus(result.status as StatusShape);
        })
        .finally(() => setBusy(false));
    },
    [rpc],
  );

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Antigravity</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Checking…
        </CardContent>
      </Card>
    );
  }

  const blocked = status.agyMissing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Antigravity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-0.5">
          <Row
            label="Provider"
            value={`${status.providerId} — ${
              status.pickerRegistered === true || status.enabled
                ? "in picker"
                : "not registered"
            }`}
            tone={
              status.pickerRegistered === true || status.enabled ? "good" : "normal"
            }
          />
          <Row label="Transport" value={status.transport} />
          <Row
            label="agy"
            value={
              status.agy
                ? `${status.agy.version ?? status.agy.path}${
                    status.agy.authState === "ok"
                      ? ` — ${status.agy.modelCount} models`
                      : status.agy.authState === "failed"
                        ? " — not authenticated"
                        : " — auth unverified from the server process"
                  }`
                : "missing"
            }
            tone={
              status.agy?.authState === "ok"
                ? "good"
                : status.agy?.authState === "failed"
                  ? "bad"
                  : "normal"
            }
          />
          <Row
            label="Adapter"
            value={status.adapterPath ?? "missing"}
            tone={status.adapterMissing ? "bad" : "good"}
          />
          <Row label="Config" value={status.configPath} />
        </div>

        {status.drift ? (
          <p className="text-xs text-destructive">
            Registered entry is stale: {status.drift}. Re-run Enable.
          </p>
        ) : null}

        {status.agyMissing ? (
          <p className="text-xs text-muted-foreground font-mono">
            curl -fsSL https://antigravity.google/cli/install.sh | bash
          </p>
        ) : null}
        {status.adapterMissing ? (
          <p className="text-xs text-muted-foreground">
            Enable downloads agy-acp into ~/.local/bin automatically.
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy || blocked}
            onClick={() => apply("enable")}
          >
            {status.enabled ? "Re-apply" : "Enable"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !status.enabled}
            onClick={() => apply("disable")}
          >
            Disable
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>
            Refresh
          </Button>
        </div>

        {message ? (
          <p className="text-xs text-muted-foreground">{message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "antigravity-status",
    title: "Antigravity",
    component: AntigravityPanel,
  });
});
