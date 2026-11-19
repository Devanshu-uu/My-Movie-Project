"use client";

import CatalogErrorState from "@/components/ui/other/CatalogErrorState";
import PopcornTvLoader from "@/components/ui/other/PopcornTvLoader";
import RowHeader from "@/components/ui/other/RowHeader";
import Carousel from "@/components/ui/wrapper/Carousel";
import { CatalogListResponse, CatalogSuggestionItem } from "@/types";
import { unwrapCatalog } from "@/utils/catalog";
import { getImageUrl } from "@/utils/movies";
import { useInViewport } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { FaPlay } from "react-icons/fa6";
import { kebabCase } from "string-ts";

interface ShowcaseRowProps {
  title: string;
  query: () => Promise<CatalogListResponse<CatalogSuggestionItem>>;
}

const RECENT_DAYS = 120;

const daysSince = (date?: string): number | null => {
  if (!date) return null;
  const time = new Date(date).getTime();
  if (!Number.isFinite(time)) return null;
  return (Date.now() - time) / 86_400_000;
};

const ShowcaseCard: React.FC<{ item: CatalogSuggestionItem }> = ({ item }) => {
  const isTv = item.media_type === "tv";
  const age = daysSince(item.release_date);
  const isRecent = age !== null && age >= 0 && age <= RECENT_DAYS;
  const badge = isRecent ? (isTv ? "New Episode" : "Recently added") : null;

  return (
    <Link
      href={isTv ? `/tv/${item.id}` : `/movie/${item.id}`}
      className="embla__slide group block w-[240px] shrink-0 sm:w-[280px] md:w-[300px]"
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-[#141414] ring-1 ring-white/10 shadow-[0_14px_30px_rgba(0,0,0,0.4)] transition duration-300 group-hover:ring-[#E50914]/70">
        <img
          alt={item.title}
          src={getImageUrl(item.backdrop_path || item.poster_path || undefined, "backdrop")}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black shadow-lg">
            <FaPlay className="ml-0.5 h-4 w-4" />
          </span>
        </div>
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
          {badge && (
            <span className="rounded-[3px] bg-[#E50914] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              {badge}
            </span>
          )}
          <span className="rounded-[3px] bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black">
            Watch Now
          </span>
        </div>
      </div>
    </Link>
  );
};

const ShowcaseRow: React.FC<ShowcaseRowProps> = ({ title, query }) => {
  const key = `${kebabCase(title)}-showcase`;
  const { ref, inViewport } = useInViewport();
  const { data, isPending, isError, error, refetch, isRefetching } = useQuery({
    queryKey: [key],
    queryFn: async () => unwrapCatalog(await query()),
    enabled: inViewport,
    staleTime: 1000 * 60 * 10,
  });

  const results = data?.results ?? [];

  return (
    <section id={key} className="min-h-[240px] md:min-h-[290px]" ref={ref}>
      <div className="flex flex-col gap-2">
        <RowHeader title={title} className="px-4 md:px-12" />

        {isPending && (
          <div className="flex min-h-[200px] items-center justify-center">
            <PopcornTvLoader size="md" label={`Fetching ${title.toLowerCase()}`} />
          </div>
        )}

        {!isPending && isError && (
          <div className="px-4 md:px-12">
            <CatalogErrorState
              compact
              error={error}
              isRetrying={isRefetching}
              onRetry={() => refetch()}
            />
          </div>
        )}

        {!isPending && !isError && results.length > 0 && (
          <div className="px-4 md:px-12">
            <Carousel>
              {results.map((item) => (
                <ShowcaseCard key={`${item.media_type}-${item.id}`} item={item} />
              ))}
            </Carousel>
          </div>
        )}
      </div>
    </section>
  );
};

export default ShowcaseRow;
