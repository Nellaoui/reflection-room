import ReflectionWorkspace from "@/app/components/ReflectionWorkspace";
import PortalGuard from "@/app/components/PortalGuard";

export const dynamic = "force-dynamic";

export default function TeacherPage() {
  return <PortalGuard portal="teacher"><ReflectionWorkspace portal="teacher"/></PortalGuard>;
}
