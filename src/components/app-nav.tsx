"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The app's navigation, grouped by when you actually reach for it.
 *
 * It was ten links in a row, every one the same weight, with nothing marking
 * where you were — so "write up last night" and "restore a backup" sat side by
 * side and neither was findable. The groups are the journal's own rhythm:
 * something to write this morning, the archive to read, the patterns that
 * accumulate over months, and the things touched twice a year.
 *
 * A client component only because the current page has to be marked, which
 * needs the pathname. It renders as a sidebar from `md` up and as one
 * scrollable row below that, with no menu to open — a phone at 4am should not
 * have to find a hamburger, and the whole thing must work if JavaScript has
 * not arrived yet.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Route prefixes that should light this item up, beyond `href` itself. */
  match?: string[];
  /** Drafts waiting, or photographs not yet read. */
  badge?: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function AppNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Journal">
      {/* Sidebar: the groups are visible, so the shape of the app is too. */}
      <div className="hidden md:block md:space-y-6">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className="px-3 text-[0.6875rem] font-medium uppercase tracking-wider text-ink-600">
              {group.label}
            </p>
            {group.items.map((item) => (
              <NavRow key={item.href} item={item} pathname={pathname} />
            ))}
          </div>
        ))}
      </div>

      {/* Phone: one row, scrolled sideways. Group labels would cost a line of
          screen each and say nothing a short list does not already say. */}
      <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:hidden">
        {groups.flatMap((group) =>
          group.items.map((item) => (
            <NavChip key={item.href} item={item} pathname={pathname} />
          )),
        )}
      </div>
    </nav>
  );
}

function isCurrent(item: NavItem, pathname: string): boolean {
  const prefixes = [item.href, ...(item.match ?? [])];
  return prefixes.some((prefix) =>
    prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function NavRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const current = isCurrent(item, pathname);
  return (
    <Link
      href={item.href}
      aria-current={current ? "page" : undefined}
      className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors ${
        current
          ? "bg-ink-800 font-medium text-ink-100"
          : "text-ink-400 hover:bg-ink-900 hover:text-ink-200"
      }`}
    >
      <span>{item.label}</span>
      <Badge count={item.badge} />
    </Link>
  );
}

function NavChip({ item, pathname }: { item: NavItem; pathname: string }) {
  const current = isCurrent(item, pathname);
  return (
    <Link
      href={item.href}
      aria-current={current ? "page" : undefined}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
        current ? "bg-ink-800 font-medium text-ink-100" : "text-ink-400 hover:text-ink-200"
      }`}
    >
      {item.label}
      <Badge count={item.badge} />
    </Link>
  );
}

function Badge({ count }: { count?: number }) {
  if (!count) return null;
  return (
    <span className="rounded-full bg-warn-500/20 px-1.5 py-0.5 text-xs text-warn-500">
      {count}
    </span>
  );
}
