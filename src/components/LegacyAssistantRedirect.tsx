import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { legacyAssistantTarget } from "@/lib/legacyAssistantRoute";

export function LegacyAssistantRedirect() {
  const { ctx = "" } = useParams();
  const [params] = useSearchParams();
  return (
    <Navigate
      replace
      to={legacyAssistantTarget(ctx, {
        kind: params.get("kind") ?? "",
        namespace: params.get("namespace") ?? params.get("ns"),
        name: params.get("name") ?? "",
      }, params.toString())}
    />
  );
}
