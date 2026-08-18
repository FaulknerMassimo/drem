"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the page while a model job is in flight.
 *
 * The worker runs in-process and writes the insight when it finishes; the
 * page does not otherwise know. Two seconds is slow enough not to hammer the
 * server and fast enough that a local model finishing feels like it landed.
 */
export function JobRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
