import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import theme from "@theme";
import { siteConfigQuery, siteDomainQuery } from "@/features/config/queries";
import { approvedFriendLinksQuery } from "@/features/friend-links/queries";
import { buildPageTitle, buildCanonicalUrl, canonicalLink } from "@/lib/seo";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/_public/friend-links")({
  component: FriendLinksPage,
  loader: async ({ context }) => {
    const [, domain, siteConfig] = await Promise.all([
      context.queryClient.ensureQueryData(approvedFriendLinksQuery()),
      context.queryClient.ensureQueryData(siteDomainQuery),
      context.queryClient.ensureQueryData(siteConfigQuery),
    ]);

    return {
      title: buildPageTitle(m.friend_links_title(), siteConfig.title),
      description: m.friend_links_desc(),
      canonicalHref: buildCanonicalUrl(domain, "/friend-links"),
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.title,
      },
      {
        name: "description",
        content: loaderData?.description,
      },
    ],
    links: [canonicalLink(loaderData?.canonicalHref ?? "/friend-links")],
  }),
  pendingComponent: theme.FriendLinksPageSkeleton,
});

function FriendLinksPage() {
  const { data: links } = useSuspenseQuery(approvedFriendLinksQuery());

  return <theme.FriendLinksPage links={links} />;
}
