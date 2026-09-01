import { DashboardGuard } from "@/components/dashboard-guard";

export const metadata = { title: "Pagamentos · Sabemi" };

export default function DashboardPage() {
  return <DashboardGuard />;
}
