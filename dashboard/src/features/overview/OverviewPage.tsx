import { Check, Copy, Globe } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stack } from "../../components/ui/stack";
import { ApiKeysPanel } from "../../components/ApiKeysPanel";
import { CompressionPanel } from "../../components/CompressionPanel";
import { useTrackedTimeout } from "../../hooks/use-timeout";

// ── API Endpoint Card ─────────────────────────────────────────────────────────

function ApiEndpointCard() {
  const [copied, setCopied] = useState(false);
  const schedule = useTrackedTimeout();
  const endpoint = `${window.location.origin}/v1`;

  const copy = () => {
    void navigator.clipboard.writeText(endpoint);
    setCopied(true);
    schedule(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader
        title="Gateway Endpoint"
        subtitle="Universal OpenAI & Anthropic Wire API Endpoint"
        icon={<Globe size={16} />}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={copy}
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        }
      />
      <CardBody>
        <Stack gap="10px">
          <div
            className="font-mono tabular-nums" style={{ padding: "10px 14px",
              borderRadius: "10px",
              border: "1px solid var(--inner-border)",
              background: "var(--code-surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-primary)" }}
          >
            <code>{endpoint}</code>
            <span style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 400 }}>
              PORT 12800
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Point any SDK, CLI, or agent (e.g. Claude Code, Windsurf, OpenCode) to this same-origin
            base URL.
          </p>
        </Stack>
      </CardBody>
    </Card>
  );
}

// ── Main Page Export ──────────────────────────────────────────────────────────

export default function Overview(): ReactNode {
  return (
    <Stack gap="16px">
      <ApiEndpointCard />
      <CompressionPanel />
      <ApiKeysPanel />
    </Stack>
  );
}
