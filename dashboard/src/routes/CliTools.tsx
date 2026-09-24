import { Terminal, Wrench } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Card, CardHeader } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state";
import { SectionHeading } from "../components/ui/layout";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { useToolRegistry, useToolStatuses } from "../lib/hooks/cli-tools";
import type { ToolStatus } from "../lib/contracts";
import { ToolIcon } from "./cli-tools/ToolIcon";
export default function CliTools(): ReactNode {
  const registryQuery = useToolRegistry();
  const statusesQuery = useToolStatuses();

  const statusMap = useMemo(() => {
    const map = new Map<string, ToolStatus>();
    const data = statusesQuery.data;
    if (!data) return map;
    if (Array.isArray(data)) {
      for (const s of data) {
        if (s?.toolId) map.set(s.toolId, s);
      }
    } else if (typeof data === "object") {
      for (const [key, val] of Object.entries(data)) {
        if (val) map.set((val as ToolStatus).toolId || key, val as ToolStatus);
      }
    }
    return map;
  }, [statusesQuery.data]);

  if (registryQuery.isLoading) return <LoadingState label="Loading CLI tools…" />;
  if (registryQuery.isError || !registryQuery.data) {
    return (
      <ErrorState
        title="Unable to load CLI tools"
        message={registryQuery.error?.message ?? "Could not load the CLI tools registry."}
        onRetry={() => void registryQuery.refetch()}
      />
    );
  }

  const tools = registryQuery.data;
  const fileTools = tools.filter((tool) => tool.configType !== "guide");
  const guideTools = tools.filter((tool) => tool.configType === "guide");
  const configuredCount = fileTools.filter((tool) => statusMap.get(tool.id)?.configured).length;
  return (
    <Stack gap="16px">
      <Card>
        <CardHeader
          title="Overview"
          subtitle={`${configuredCount}/${fileTools.length} file-injected tools configured`}
          icon={<Terminal size={16} />}
          action={<Badge tone="accent">{`${tools.length} tools`}</Badge>}
        />
      </Card>

      <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <SectionHeading
          title={`File-injected tools (${fileTools.length})`}
          description="Direct config file writing and preset model mappings"
          icon={<Wrench size={14} />}
        />

        <div className="provider-grid">
          {fileTools.map((tool) => {
            const status = statusMap.get(tool.id);
            return (
              <Card
                key={tool.id}
                interactive
                style={{
                  position: "relative",
                  overflow: "hidden",
                  border: "1px solid var(--inner-border)",
                  borderRadius: "12px",
                }}
              >
                <Link
                  to={`/cli-tools/${tool.id}`}
                  style={{
                    textDecoration: "none",
                    color: "inherit",
                    display: "block",
                    padding: "12px",
                  }}
                >
                  <Inline gap="10px">
                    <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={32} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {tool.name}
                      </div>
                      <div style={{ marginTop: "3px" }}>
                        {status?.configured ? (
                          <Badge tone="ok" dot>
                            Configured
                          </Badge>
                        ) : status?.installed ? (
                          <Badge tone="warn" dot>
                            Installed
                          </Badge>
                        ) : (
                          <Badge>Not installed</Badge>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: "3px",
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "10px",
                          fontWeight: 600,
                          background: "var(--kbd-bg)",
                          padding: "1px 5px",
                          borderRadius: "4px",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {tool.id}
                      </span>
                      {tool.surface ? <Badge tone="default">{tool.surface}</Badge> : null}
                    </div>
                  </Inline>
                </Link>
              </Card>
            );
          })}
        </div>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <SectionHeading
          title={`Guide-only tools (${guideTools.length})`}
          description="Manual setup steps and exportable config templates"
          icon={<Terminal size={14} />}
        />

        <div className="provider-grid">
          {guideTools.map((tool) => (
            <Card
              key={tool.id}
              interactive
              style={{
                position: "relative",
                overflow: "hidden",
                border: "1px solid var(--inner-border)",
                borderRadius: "12px",
              }}
            >
              <Link
                to={`/cli-tools/${tool.id}`}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  display: "block",
                  padding: "12px",
                }}
              >
                <Inline gap="10px">
                  <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={32} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tool.name}
                    </div>
                    <div style={{ marginTop: "3px" }}>
                      <Badge tone="info">Guide</Badge>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: "3px",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "10px",
                        fontWeight: 600,
                        background: "var(--kbd-bg)",
                        padding: "1px 5px",
                        borderRadius: "4px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {tool.id}
                    </span>
                    {tool.surface ? <Badge tone="default">{tool.surface}</Badge> : null}
                  </div>
                </Inline>
              </Link>
            </Card>
          ))}
        </div>
      </section>
    </Stack>
  );
}
