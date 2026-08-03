import { useAction, useQuery } from "convex/react";
import { ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";

interface Preview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  domain: string;
}

export function LinkCard({ url }: { url: string }) {
  const cached = useQuery(api.links.getUrlPreview, { url });
  const fetchPreview = useAction(api.links.fetchUrlPreview);
  const [local, setLocal] = useState<Preview | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (cached === undefined) return;
    if (cached === null && !tried.current) {
      tried.current = true;
      void fetchPreview({ url })
        .then((p) => setLocal(p))
        .catch(() => setLocal(null));
    }
  }, [cached, url, fetchPreview]);

  const preview = cached ?? local;
  if (!preview) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 block overflow-hidden rounded-xl border bg-muted/40 transition-colors hover:bg-muted/70"
    >
      <div className="flex">
        {preview.image ? (
          <div className="hidden w-32 shrink-0 sm:block">
            <img
              src={preview.image}
              alt=""
              className="size-full object-cover"
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1 p-3">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {preview.image ? (
              <Globe className="size-3.5 shrink-0" />
            ) : (
              <ExternalLink className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{preview.domain}</span>
          </p>
          {preview.title ? (
            <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug">
              {preview.title}
            </p>
          ) : null}
          {preview.description ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {preview.description}
            </p>
          ) : (
            <p className="mt-1 truncate text-xs text-muted-foreground">{url}</p>
          )}
        </div>
      </div>
    </a>
  );
}
