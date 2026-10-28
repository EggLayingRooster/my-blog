import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { SITE_TIME_ZONE } from "@/lib/constants";

export const isSSR = typeof window === "undefined";

export function cn(...inputs: Array<ClassValue>) {
  return twMerge(clsx(inputs));
}

function getIntlLocale() {
  return getLocale() === "zh" ? "zh-CN" : "en-US";
}

/**
 * 使用固定的站点时区 + 当前 locale 格式化日期。
 * 服务端与客户端输出一致（不再依赖运行环境时区），因此可以安全地 SSR 渲染。
 */
export function formatDate(
  date: Date | undefined | null | string | number,
  options: { includeTime?: boolean } = {},
) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";

  const locale = getLocale();
  const includeTime = options.includeTime === true;

  return new Intl.DateTimeFormat(getIntlLocale(), {
    year: "numeric",
    month: locale === "zh" ? "long" : "2-digit",
    day: locale === "zh" ? "numeric" : "2-digit",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
    timeZone: SITE_TIME_ZONE,
  }).format(d);
}

export function formatTime(date: Date | undefined | null | string | number) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getIntlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: SITE_TIME_ZONE,
  }).format(d);
}

export function formatMonthDayTime(
  date: Date | undefined | null | string | number,
) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getIntlLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: SITE_TIME_ZONE,
  }).format(d);
}

export function formatMonthDay(date: Date | undefined | null | string | number) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getIntlLocale(), {
    month: "short",
    day: "numeric",
    timeZone: SITE_TIME_ZONE,
  }).format(d);
}

export function formatTimeAgo(date: Date | null | string) {
  if (!date) return "";
  const now = new Date();
  const diffInSeconds = Math.floor(
    (now.getTime() - new Date(date).getTime()) / 1000,
  );

  if (diffInSeconds < 60) return m.time_ago_just_now();
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return m.time_ago_minutes({ count: diffInMinutes });
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return m.time_ago_hours({ count: diffInHours });
  const diffInDays = Math.floor(diffInHours / 24);
  return m.time_ago_days({ count: diffInDays });
}

export function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}
