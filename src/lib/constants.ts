export const ADMIN_ITEMS_PER_PAGE = 12;

/** 公开文章列表的每页条数（缓存键与回源查询必须使用同一个值） */
export const POSTS_PAGE_SIZE = 12;

/** 公开列表/详情单页最多返回条数（防止匿名请求用超大/负数 limit 拖库或刷缓存） */
export const MAX_POSTS_PAGE_SIZE = 50;

/** 本模块（数据与缓存）使用的 TTL，集中管理避免魔法值散落 */
export const CACHE_TTL = {
  postsList: "7d",
  postsDetail: "7d",
  pinnedPosts: "7d",
  relatedPosts: "7d",
  popularPosts: "3h",
  viewCounts: "5m",
  dashboardTraffic: "3h",
  autoSnapshotThrottle: "60s",
} as const;

export const CACHE_CONTROL = {
  public: {
    // 浏览器端每次都要回源校验；CDN 端只短暂缓存作为"purge 失败"的兜底，
    // 避免 purge 失效时前台内容长期不更新（历史上出现过）。
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": "public, s-maxage=300",
  },
  swr: {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": "public, s-maxage=1, stale-while-revalidate=604800",
  },
  immutable: {
    "Cache-Control": "public, max-age=31536000, immutable",
    "CDN-Cache-Control": "public, max-age=31536000, immutable",
  },
  forbidden: {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": "public, s-maxage=3600",
  },
  notFound: {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": "public, s-maxage=10",
  },
  serverError: {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": "public, s-maxage=10",
  },
  private: {
    "Cache-Control": "private, no-store, no-cache, must-revalidate",
    "CDN-Cache-Control": "private, no-store",
  },
} as const;

export const ADMIN_STATS = {
  totalViews: 45231,
  etherStability: 89.4,
  systemHealth: "STABLE",
  pendingComments: 12,
  databaseSize: "1.2 GB",
};
