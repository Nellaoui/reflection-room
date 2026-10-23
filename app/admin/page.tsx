import ReflectionWorkspace from "@/app/components/ReflectionWorkspace";
import PortalGuard from "@/app/components/PortalGuard";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <PortalGuard portal="admin"><ReflectionWorkspace portal="admin"/></PortalGuard>;
}
