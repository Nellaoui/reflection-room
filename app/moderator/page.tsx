import InsightsWorkspace from "@/app/components/InsightsWorkspace";
import PortalGuard from "@/app/components/PortalGuard";

export const dynamic = "force-dynamic";

export default function ModeratorPage() {
  return <PortalGuard portal="moderator"><InsightsWorkspace/></PortalGuard>;
}
