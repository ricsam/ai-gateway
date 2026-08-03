import { Outlet, createRootRoute } from "@richie-router/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import { loadPublicConfig } from "../config";

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  useEffect(() => {
    void loadPublicConfig().then((config) => {
      document.documentElement.style.setProperty("--brand-primary", config.brand.primaryColor);
      document.documentElement.style.setProperty("--brand-primary-foreground", config.brand.primaryForegroundColor);
      document.title = config.brand.name;
      if (config.brand.faviconUrl) {
        let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (!icon) { icon = document.createElement("link"); icon.rel = "icon"; document.head.append(icon); }
        icon.href = config.brand.faviconUrl;
      }
    });
  }, []);

  return <TooltipProvider><div className="min-h-screen bg-background"><Outlet /></div></TooltipProvider>;
}
