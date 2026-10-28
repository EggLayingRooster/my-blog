import type { FriendLinkPublic } from "@/features/friend-links/friend-links.schema";

interface FriendLinkCardProps {
  link: FriendLinkPublic;
}

export function FriendLinkCard({ link }: FriendLinkCardProps) {
  // 防御：仅允许 http(s) 链接作为 href/src（历史数据可能包含危险协议）
  const safeHref = /^https?:\/\//i.test(link.siteUrl) ? link.siteUrl : "#";
  const safeLogoUrl =
    link.logoUrl && /^https?:\/\//i.test(link.logoUrl)
      ? link.logoUrl
      : undefined;

  // Extract domain for display
  const displayUrl = link.siteUrl
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-4 p-4 rounded-lg hover:bg-muted/40 transition-colors border border-transparent hover:border-border/40"
    >
      {/* Logo */}
      <div className="shrink-0 w-10 h-10 rounded-md bg-muted/30 border border-border/40 flex items-center justify-center overflow-hidden">
        {safeLogoUrl ? (
          <img
            src={safeLogoUrl}
            alt={link.siteName}
            className="w-full h-full object-cover transition-all duration-300"
            loading="lazy"
          />
        ) : (
          <span className="text-sm font-serif font-medium text-muted-foreground/60">
            {link.siteName.slice(0, 1)}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-foreground tracking-tight truncate group-hover:underline decoration-border/60 underline-offset-4 decoration-1">
            {link.siteName}
          </h3>
          <span className="text-[10px] font-mono text-muted-foreground/30 hidden sm:block truncate shrink-0">
            {displayUrl}
          </span>
        </div>

        <div className="min-h-[2.5em]">
          {link.description ? (
            <p className="text-sm text-muted-foreground/80 leading-relaxed line-clamp-2">
              {link.description}
            </p>
          ) : null}
        </div>
      </div>
    </a>
  );
}
