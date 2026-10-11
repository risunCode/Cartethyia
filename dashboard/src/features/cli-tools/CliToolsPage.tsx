import { Terminal } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/ui/badge";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { SectionHeading } from "../../components/ui/layout";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { useToolRegistry, useToolStatuses } from "../../hooks/cli-tools";
import type { ToolStatus } from "../../data/contracts";
import { ToolIcon } from "./icons/ToolIcon";
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
  if (tools.length === 0) {
    return (
      <div className="empty-panel">
        <EmptyState
          title="No CLI tools registered"
          message="The registry is empty, so there is nothing to configure yet."
        />
      </div>
    );
  }
  return (
    <Stack gap="16px">
      <Card>
        <CardHeader
          title="CLI Tools"
          subtitle={`${configuredCount}/${fileTools.length} file-injected tools configured`}
          icon={<Terminal size={16} />}
          action={<Badge tone="accent">{`${tools.length} tools`}</Badge>}
        />
        <CardBody className="flex flex-col gap-8">
      <section className="flex flex-col gap-6">
        <SectionHeading
          title={`File-injected tools (${fileTools.length})`}
          description="Direct config file writing and preset model mappings"
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
                  className="no-underline text-inherit block p-6"
                >
                  <Inline gap="10px">
                    <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={32} />
                    <div className="min-w-0 flex-1">
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
                      <div className="mt-1.5">
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
                      className="flex flex-col items-end gap-1.5 shrink-0"
                    >
                      <span className="font-mono tabular-nums text-micro font-semibold bg-kbd-bg py-0.5 px-2.5 rounded-tiny text-text-secondary">
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

      <section className="flex flex-col gap-6">
        <SectionHeading
          title={`Guide-only tools (${guideTools.length})`}
          description="Manual setup steps and exportable config templates"
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
                className="no-underline text-inherit block p-6"
              >
                <Inline gap="10px">
                  <ToolIcon toolId={tool.id} name={tool.name} color={tool.color} size={32} />
                  <div className="min-w-0 flex-1">
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
                    <div className="mt-1.5">
                      <Badge tone="info">Guide</Badge>
                    </div>
                  </div>

                  <div
                    className="flex flex-col items-end gap-1.5 shrink-0"
                  >
                    <span className="font-mono tabular-nums text-micro font-semibold bg-kbd-bg py-0.5 px-2.5 rounded-tiny text-text-secondary">
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
        </CardBody>
      </Card>
    </Stack>
  );
}
