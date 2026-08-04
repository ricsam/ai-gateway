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
      let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (config.brand.faviconUrl) {
        if (!icon) { icon = document.createElement("link"); icon.rel = "icon"; document.head.append(icon); }
        icon.href = config.brand.faviconUrl;
      } else {
        icon?.remove();
      }
    });
  }, []);

  return <TooltipProvider><div className="min-h-screen bg-background"><Outlet /></div></TooltipProvider>;
}
