import ReflectionWorkspace from "./components/ReflectionWorkspace";
import InsightsWorkspace from "./components/InsightsWorkspace";
import { getStaffIdentity } from "./lib/staff-auth";
import { getPortalAccess } from "./lib/portal-access";

export default async function HomePage() {
  const access = await getPortalAccess(await getStaffIdentity(), "moderator");
  if (access.allowed && access.role === "moderator") return <InsightsWorkspace/>;
  return <ReflectionWorkspace />;
}
