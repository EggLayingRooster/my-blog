import { TanStackDevtools } from "@tanstack/react-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import TanStackQueryDevtools from "@/integrations/tanstack-query/devtools";

/** 仅在开发环境按需加载，避免把 Devtools 打进生产 bundle */
export default function Devtools() {
  return (
    <TanStackDevtools
      config={{ position: "bottom-right" }}
      plugins={[
        { name: "Tanstack Router", render: <TanStackRouterDevtoolsPanel /> },
        TanStackQueryDevtools,
      ]}
    />
  );
}
