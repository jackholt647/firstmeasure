export type FirstMeasureProcessRole = "combined" | "web" | "worker";

export function getFirstMeasureProcessRole(value = process.env.FIRSTMEASURE_PROCESS_ROLE): FirstMeasureProcessRole {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "web" || normalized === "worker") return normalized;
  const clusterRole = String(process.env.CLUSTER_NODE_ROLE ?? "").trim().toLowerCase();
  if (clusterRole === "worker") return "worker";
  if (clusterRole === "web" || clusterRole === "legacy") return "web";
  if (String(process.env.DEPLOYMENT_TOPOLOGY ?? "").trim().toLowerCase() === "cluster") return "web";
  return "combined";
}

export function shouldRunFirstMeasureBackgroundProcessor(
  role = getFirstMeasureProcessRole(),
  clusterWorkerId = String(process.env.V1_CLUSTER_WORKER ?? "").trim()
) {
  if (role === "web") return false;
  if (role === "worker") return true;
  return !clusterWorkerId || clusterWorkerId === "1";
}
