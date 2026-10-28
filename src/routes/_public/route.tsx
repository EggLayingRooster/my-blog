import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import theme from "@theme";
import { useEffect } from "react";
import { toast } from "sonner";
import { AUTH_KEYS } from "@/features/auth/queries";
import { getThemePreloadImages } from "@/features/theme/site-config.helpers";
import { authClient } from "@/lib/auth/auth.client";
import { getLogoutAuthErrorMessage } from "@/lib/auth/auth-errors";
import { CACHE_CONTROL } from "@/lib/constants";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/_public")({
  loader: ({ context }) => ({
    preloadImages: getThemePreloadImages(context.siteConfig),
  }),
  component: PublicLayout,
  headers: () => {
    // HTML 内容随 locale（Cookie / Accept-Language）变化，不能按 URL 共享缓存，
    // 否则不同语言的访客会互相看到对方语言的页面（Cache API / CDN 都会串）。
    // 这里让 HTML 只做浏览器端校验（max-age=0）并禁止 CDN 缓存；
    // Worker 的 Cache API 也会在 cacheMiddleware 中跳过 text/html。
    return {
      ...CACHE_CONTROL.public,
      "CDN-Cache-Control": "private, no-store",
      Vary: "Cookie, Accept-Language",
    };
  },
  head: ({ loaderData }) => ({
    links: (loaderData?.preloadImages ?? []).map((href) => ({
      rel: "preload" as const,
      as: "image",
      href,
    })),
  }),
});

function PublicLayout() {
  const navigate = useNavigate();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const queryClient = useQueryClient();

  const navOptions = [
    { label: m.nav_home(), to: "/" as const, id: "home" },
    { label: m.nav_posts(), to: "/posts" as const, id: "posts" },
    {
      label: m.nav_friend_links(),
      to: "/friend-links" as const,
      id: "friend-links",
    },
  ];

  const logout = async () => {
    const { error } = await authClient.signOut();
    if (error) {
      toast.error(m.auth_logout_failed(), {
        description:
          getLogoutAuthErrorMessage(error, m) ?? m.auth_logout_failed_desc(),
      });
      return;
    }

    queryClient.removeQueries({ queryKey: AUTH_KEYS.session });

    toast.success(m.auth_logout_success(), {
      description: m.auth_logout_success_desc(),
    });
  };

  // Global shortcut: Cmd/Ctrl + K to navigate to search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isToggle = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isToggle) {
        e.preventDefault();
        navigate({ to: "/search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <>
      <theme.PublicLayout
        navOptions={navOptions}
        user={session?.user}
        isSessionLoading={isSessionPending}
        logout={logout}
      >
        <Outlet />
      </theme.PublicLayout>
      <theme.Toaster />
    </>
  );
}
