import { Workflow } from "lucide-react";
import { AdvancedPlaceholder } from "./placeholder";
import { CliToolsPage as CliToolsPageImpl } from "./cli-tools/page";

export function AutomationPage() {
  return <AdvancedPlaceholder title="Automation" description="Scheduled tasks and workflow triggers — coming soon" icon={Workflow} />;
}

export function CliToolsPage() {
  return <CliToolsPageImpl />;
}
